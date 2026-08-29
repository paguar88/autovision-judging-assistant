#!/usr/bin/env node
/**
 * Concours Judging Assistant - Source Ingestion Pipeline
 * Addendum A.5 (Ingestion), A.6 (Page-level retrieval + citation), A.7 (Page slices).
 *
 * Scripted, repeatable, idempotent. Fails closed.
 *
 * Produces, under build/<brand>/ :
 *   page-map.json                 citation validation + diagnostics + regression baseline
 *   document-manifest.json        generated counterpart to curated config/source-index.json
 *   retrieval-units/*.md          page-level retrieval units for the vector store
 *   retrieval-units.json          unit index incl. verbatim overlap spans and origin pages
 *   page-slices/<doc>/p####.pdf   unaltered single-page PDF slices
 *   transcription-vocabulary.json candidate terminology (NOT aliases - A.14)
 *   ingestion-report.json         successes, warnings, blocking errors
 *
 * Usage: node scripts/ingest.mjs [--brand ferrari] [--skip-slices] [--corpus-dir <path>]
 *
 * --corpus-dir points the pipeline at a source folder outside the repository.
 * It exists so a large test corpus can be ingested from local disk without the
 * PDFs entering git or the Netlify build (netlify.toml rebuilds from
 * approved-source-docs/ on every deploy). The default is unchanged, so the
 * production `--brand ferrari` run behaves exactly as before.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BRAND = argVal('--brand') || 'ferrari';
const SKIP_SLICES = args.includes('--skip-slices');

// Corpus location. Resolution order: CLI flag, then brand config, then the
// historical default. `ferrari` declares no corpus_dir, so it resolves to
// approved-source-docs/ exactly as before this flag existed.
const CORPUS_DIR_FLAG = argVal('--corpus-dir');

// ---- Tunables (configuration, not product logic) ----------------------------
const OVERLAP_CHARS = 600;          // A.6 page-break overlap, retrieval context only
const SLICE_THRESHOLD_BYTES = 5 * 1024 * 1024;  // A.7 delivery threshold (~5 MB)
const VOCAB_MIN_FREQ = 3;
const VOCAB_MAX_TERMS = 400;

function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// ---- Report accumulator -----------------------------------------------------
const report = {
  run_at: new Date().toISOString(),
  brand: BRAND,
  pipeline_version: '1.0.0',
  status: 'PENDING',
  documents: [],
  cross_document_references: [],
  corpus_config_validation: { documents_without_alias_entry: [], aliases_without_document: [], aliases_covered_by_curation_only: [], unmapped_note: null },
  warnings: [],
  blocking_errors: [],
  totals: {},
};

const warn = (code, message, detail = {}) => report.warnings.push({ code, message, ...detail });
const block = (code, message, detail = {}) => report.blocking_errors.push({ code, message, ...detail });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const normalize = (s) => s.replace(/\s+/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').trim().toLowerCase();

// ---- Load curated configuration --------------------------------------------
const brandsCfg = JSON.parse(readFileSync(path.join(ROOT, 'config/brands.json'), 'utf8'));
const brandCfg = brandsCfg.brands[BRAND];
if (!brandCfg) { console.error(`Unknown brand: ${BRAND}`); process.exit(2); }

const sourceIndex = JSON.parse(readFileSync(path.join(ROOT, brandCfg.source_index), 'utf8'));
const aliasTable = loadOptional(brandCfg.model_aliases, { models: [] });
const mappingTable = loadOptional(brandCfg.score_sheet_mappings, { mappings: [] });

function loadOptional(rel, fallback) {
  const p = path.join(ROOT, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}

const OUT = path.join(ROOT, 'build', BRAND);
const UNITS_DIR = path.join(OUT, 'retrieval-units');
const SLICES_DIR = path.join(OUT, 'page-slices');

// An absolute --corpus-dir is used as given; a relative one resolves against the
// repository root, as approved-source-docs/ always has.
const CORPUS_REL = CORPUS_DIR_FLAG || brandCfg.corpus_dir || 'approved-source-docs';
const CORPUS_DIR = path.isAbsolute(CORPUS_REL) ? CORPUS_REL : path.join(ROOT, CORPUS_REL);
if (!existsSync(CORPUS_DIR)) {
  console.error(`BLOCKED: corpus directory not found: ${CORPUS_DIR}`);
  process.exit(2);
}
console.log(`Corpus: ${CORPUS_DIR}`);

// ---- Redistribution gate (A.5) - fail closed --------------------------------
const admitted = [];
for (const doc of sourceIndex.documents) {
  const status = doc.redistribution_status;
  if (status === 'approved') { admitted.push(doc); continue; }
  if (status === 'not_approved') {
    warn('REDISTRIBUTION_EXCLUDED', `Excluded from vector store by redistribution status.`, { document_id: doc.document_id });
    continue;
  }
  block('REDISTRIBUTION_UNKNOWN',
    `Redistribution status is "${status ?? 'missing'}". Ingestion is blocked until the curator resolves it. A searchable-but-unviewable document state must not exist.`,
    { document_id: doc.document_id });
}

if (report.blocking_errors.length) finish(1);

// ---- Idempotency: rebuild output tree deterministically ----------------------
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(UNITS_DIR, { recursive: true });
mkdirSync(SLICES_DIR, { recursive: true });

// ---- Heading + folio heuristics ---------------------------------------------
const HEADING_RE = /^(?:\d+\s+)?[A-Z0-9][A-Z0-9 ,.'\/&\-()]{9,}$/;
// A wrong section heading is worse than none: it flows into the retrieval unit and
// into citation metadata. Structural markers and table header rows are denied, and a
// heading is only promoted to sticky from a page carrying real prose. Curator-editable.
const HEADING_DENY = [
  /INTENTIONALLY\s+BLANK/i,
  /^(?:PARTS?\/ASSEMBLY|LOCATION)\b/i,
  /\bREFER\s+TO\b/i,
  /^[A-Z ]*\b(?:NUMBER|WATTAGE|TYPE|COMMENTS|FINISH\/PLATING)\b[A-Z ]*$/,
];
const HEADING_MIN_PAGE_CHARS = 300;
const STICKY_HEADINGS = false;   // see note at assignment site   // don't promote headings off blank/table pages

function detectHeading(lines, pageText) {
  if ((pageText || '').replace(/\s/g, '').length < HEADING_MIN_PAGE_CHARS) return null;
  for (const raw of lines.slice(0, 4)) {
    const l = raw.trim();
    if (l.length < 10 || l.length > 110) continue;
    if (HEADING_DENY.some(re => re.test(l))) continue;
    const letters = l.replace(/[^A-Za-z]/g, '');
    if (!letters.length) continue;
    const upperRatio = letters.replace(/[^A-Z]/g, '').length / letters.length;
    if (upperRatio > 0.85 && HEADING_RE.test(l)) return l.replace(/\s+/g, ' ');
  }
  return null;
}
function detectFolio(lines) {
  for (const raw of lines.slice(-3).reverse()) {
    const m = raw.trim().match(/^(\d{1,4})$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ---- Text extraction --------------------------------------------------------
async function extractPages(absPath) {
  const data = new Uint8Array(readFileSync(absPath));
  const pdf = await getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Reconstruct lines from item vertical positions so headings/folios survive.
    const rows = new Map();
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      const y = Math.round(item.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], s: item.str });
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map(p => p.s).join('').replace(/\s+/g, ' ').trim())
      .filter(l => l.length > 0);
    pages.push({ page_number: i, lines, text: lines.join('\n') });
    page.cleanup();
  }
  await pdf.destroy();
  return pages;
}

// ---- Page slices (A.7) - unaltered, no rasterise, no recompress -------------
async function writeSlices(absPath, docId, pageCount) {
  const dir = path.join(SLICES_DIR, docId);
  mkdirSync(dir, { recursive: true });
  const srcBytes = readFileSync(absPath);
  const src = await PDFDocument.load(srcBytes, { updateMetadata: false });
  const slices = [];
  for (let i = 0; i < pageCount; i++) {
    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(src, [i]);   // copies content stream + resources verbatim
    out.addPage(copied);
    // Determinism: pdf-lib stamps a fresh timestamp on every save, which would make
    // slice_checksum drift on each re-ingest and destroy its value as an integrity
    // anchor. Pin metadata so an unchanged source page always yields an identical slice.
    out.setCreationDate(new Date(0));
    out.setModificationDate(new Date(0));
    out.setProducer('');
    out.setCreator('');
    const bytes = await out.save({ useObjectStreams: true });
    const file = path.join(dir, `p${String(i + 1).padStart(4, '0')}.pdf`);
    writeFileSync(file, bytes);
    slices.push({
      document_id: docId,
      physical_page_number: i + 1,
      slice_path: path.relative(ROOT, file),
      slice_checksum: sha256(bytes),
      slice_bytes: bytes.length,
    });
  }
  return slices;
}

// ---- Terminology harvest (A.14) - vocabulary only, never aliases ------------
const STOP = new Set(('The There These This That And But For With From Should Some Are Was Were Has Have Had Not All One Two Three Four Both Each Other Note Item Items Page Pages Document Documents Observations Observation Original Originally Front Rear Left Right Top Bottom Black Chrome Rubber Metal Early Later Cars Car Judging Judge Judges If It In On Of To A An As At Be By Or Is Its Also May Might Must Can Will Would When Where Which While Because However Therefore Pictures Picture Major Minor Same Different Correct Incorrect Only Very Most More Less Above Below Inside Outside Under Over').split(' '));
const vocabCounts = new Map();
function harvestTerms(text) {
  const re = /\b([A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,}){0,2})\b/g;
  let m;
  while ((m = re.exec(text))) {
    const term = m[1].trim();
    const head = term.split(/\s+/)[0];
    if (STOP.has(head)) continue;
    if (term.split(/\s+/).every(w => STOP.has(w))) continue;
    vocabCounts.set(term, (vocabCounts.get(term) || 0) + 1);
  }
}

// ---- Main -------------------------------------------------------------------
const pageMap = [];
const retrievalUnits = [];
const manifestDocs = [];
let totalPages = 0, totalSlices = 0, totalSliceBytes = 0;

for (const doc of admitted) {
  // source_path carries a corpus-relative path for foldered corpora (e.g.
  // "330 GTC/checklist.pdf"). filename remains the flat-folder form. Production's
  // source-index declares no source_path, so it takes the filename branch unchanged.
  const relPath = doc.source_path || doc.filename;
  const absPath = path.join(CORPUS_DIR, relPath);
  if (!existsSync(absPath)) {
    block('SOURCE_FILE_MISSING', `Declared in the source index but not present in the corpus directory.`, { document_id: doc.document_id, path: relPath, corpus_dir: CORPUS_DIR });
    continue;
  }
  const bytes = readFileSync(absPath);
  const docChecksum = sha256(bytes);
  const sizeBytes = statSync(absPath).size;

  // Where the curator inherited metadata from an already-curated document, the
  // assertion "this is the same file" must be proven, not trusted. Wrong metadata
  // is worse than absent metadata.
  if (doc.expected_source_checksum && doc.expected_source_checksum !== docChecksum) {
    warn('INHERITED_CHECKSUM_MISMATCH',
      `Metadata was inherited from another curated entry on the assertion that this is the same document, but the file checksum differs. The inherited title, version and description may describe a different file.`,
      { document_id: doc.document_id, expected: doc.expected_source_checksum, actual: docChecksum });
  }

  let pages;
  try {
    pages = await extractPages(absPath);
  } catch (e) {
    block('TEXT_EXTRACTION_FAILED', `Could not extract a text layer: ${e.message}`, { document_id: doc.document_id });
    continue;
  }

  // Text-layer sanity: a scanned PDF must not be silently ingested as empty units.
  const emptyPages = pages.filter(p => p.text.replace(/\s/g, '').length < 15).map(p => p.page_number);
  if (emptyPages.length === pages.length) {
    block('NO_TEXT_LAYER', `No usable text layer on any page. OCR or a different source file is required before ingestion.`, { document_id: doc.document_id });
    continue;
  }

  // Folio validation - does the printed page number agree with the physical page?
  let folioChecked = 0, folioMatched = 0;
  const folioMismatches = [];
  let stickyHeading = null;
  for (const p of pages) {
    const folio = detectFolio(p.lines);
    if (folio !== null) {
      folioChecked++;
      if (folio === p.page_number) folioMatched++;
      else folioMismatches.push({ physical_page: p.page_number, printed_folio: folio });
    }
    // Sticky propagation is OFF by default. Section structure in scanned/graphical
    // reference documents is visually formatted, not textually marked, so carrying a
    // heading forward silently mis-attributes later pages. A heading is recorded ONLY
    // on the page where it is actually detected; every other page records null.
    // Per-page section attribution, if wanted in citations, is curator-supplied
    // Tier 2 configuration - not an ingestion inference.
    const h = detectHeading(p.lines, p.text);
    p.section_heading = STICKY_HEADINGS ? (h ? (stickyHeading = h) : stickyHeading) : h;
  }
  if (folioMismatches.length) {
    warn('FOLIO_OFFSET', `Printed page numbers do not agree with physical PDF pages. Cross-document page citations into this document cannot be trusted without a curator-supplied offset.`,
      { document_id: doc.document_id, sample: folioMismatches.slice(0, 8), mismatch_count: folioMismatches.length });
  }

  const headed = pages.filter(p => p.section_heading).length;
  if (pages.length > 5 && headed / pages.length < 0.5) {
    warn('SPARSE_SECTION_HEADINGS', `Section headings were detected on only ${headed} of ${pages.length} pages. Remaining pages record no section heading rather than inheriting a possibly wrong one. Citations for those pages will show document and page only.`,
      { document_id: doc.document_id, pages_with_heading: headed, page_count: pages.length });
  }

  // Page map + retrieval units with A.6 overlap
  const unitFiles = [];
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const prev = i > 0 ? pages[i - 1] : null;
    const overlapSpan = prev ? prev.text.slice(-OVERLAP_CHARS) : null;
    const overlapOriginPage = prev ? prev.page_number : null;

    pageMap.push({
      document_id: doc.document_id,
      page_number: p.page_number,
      extracted_text: p.text,
      normalized_text: normalize(p.text),
      section_heading: p.section_heading,
      source_pdf: doc.filename,
      checksum: sha256(Buffer.from(p.text, 'utf8')),
    });

    const unitName = `${doc.document_id}__p${String(p.page_number).padStart(4, '0')}.md`;
    // The header is retrieval context. Page identity is ALSO carried as vector-store
    // file attributes at upload time - it is never reconstructed from this text.
    const header = [
      `# ${doc.display_title}`,
      // Omitted entirely when unset. An unguarded template string writes the literal
      // text "null" into the retrieval unit, which is then embedded and searched as
      // if it were document content. Absent metadata is silence, not the word "null".
      doc.document_version ? `Document version: ${doc.document_version}` : null,
      doc.source_organization ? `Source organization: ${doc.source_organization}` : null,
      `Page ${p.page_number} of ${pages.length}`,
      p.section_heading ? `Section: ${p.section_heading}` : null,
      doc.models_covered.length ? `Models covered: ${doc.models_covered.join(', ')}` : null,
    ].filter(Boolean).join('\n') + '\n\n---\n\n';

    const body = (overlapSpan ? `[continues from page ${overlapOriginPage}]\n${overlapSpan}\n\n---\n\n` : '') + p.text;
    writeFileSync(path.join(UNITS_DIR, unitName), header + body, 'utf8');
    unitFiles.push(unitName);

    retrievalUnits.push({
      unit_id: `${doc.document_id}:p${p.page_number}`,
      unit_file: unitName,
      document_id: doc.document_id,
      document_title: doc.display_title,
      document_version: doc.document_version,
      page_number: p.page_number,
      source_pdf_path: doc.filename,
      brand: BRAND,
      section_heading: p.section_heading,
      effective_year: doc.effective_year,
      superseded_status: doc.superseded_by ? 'superseded' : 'current',
      source_type: doc.source_type,
      continues_from: overlapOriginPage,
      continues_to: i < pages.length - 1 ? pages[i + 1].page_number : null,
      // A.6: overlap span stored VERBATIM with its origin page. The citation
      // resolver runs an exact substring containment test against these.
      overlap_span: overlapSpan,
      overlap_origin_page: overlapOriginPage,
      primary_text: p.text,
    });

    harvestTerms(p.text);
  }

  // Page slices (A.7)
  let slices = [];
  const deliveryMode = sizeBytes > SLICE_THRESHOLD_BYTES ? 'page_slice' : 'protected_whole_pdf';
  if (!SKIP_SLICES) {
    try {
      slices = await writeSlices(absPath, doc.document_id, pages.length);
      totalSlices += slices.length;
      totalSliceBytes += slices.reduce((a, s) => a + s.slice_bytes, 0);
    } catch (e) {
      block('PAGE_SLICE_FAILED', `Page-slice generation failed: ${e.message}`, { document_id: doc.document_id });
    }
    const bad = slices.filter(s => s.slice_bytes < 200);
    if (bad.length) warn('SLICE_SUSPECT_SIZE', `Some page slices are implausibly small and may have lost page content.`, { document_id: doc.document_id, pages: bad.map(b => b.physical_page_number).slice(0, 10) });
  }

  totalPages += pages.length;

  const docRecord = {
    document_id: doc.document_id,
    display_title: doc.display_title,
    document_version: doc.document_version,
    version_normalized: doc.version_normalized,
    publication_date: doc.publication_date,
    effective_year: doc.effective_year,
    source_organization: doc.source_organization,
    source_type: doc.source_type,
    brand: BRAND,
    models_covered: doc.models_covered,
    filename: doc.filename,
    document_checksum: docChecksum,
    size_bytes: sizeBytes,
    page_count: pages.length,
    active: doc.active,
    redistribution_status: doc.redistribution_status,
    supersedes: doc.supersedes,
    superseded_by: doc.superseded_by,
    delivery_mode: deliveryMode,
    slice_count: slices.length,
    retrieval_unit_count: unitFiles.length,
    display_description: doc.display_description,
    folio_validation: {
      pages_with_printed_folio: folioChecked,
      folio_matches_physical_page: folioMatched,
      mismatches: folioMismatches.length,
      verdict: folioMismatches.length === 0 && folioChecked > 0
        ? 'printed page numbers agree with physical pages'
        : (folioChecked === 0 ? 'no printed folios detected' : 'OFFSET DETECTED'),
    },
    pages_with_thin_text: emptyPages,
    slices,
  };
  manifestDocs.push(docRecord);
  report.documents.push({ ...docRecord, slices: undefined, pages_with_thin_text: emptyPages.length });

  if (emptyPages.length) {
    warn('THIN_TEXT_PAGES', `Pages carry little or no extractable text (likely full-page photographs). They are ingested but will rarely be retrievable by text search.`,
      { document_id: doc.document_id, page_count: emptyPages.length, sample: emptyPages.slice(0, 12) });
  }
}

if (report.blocking_errors.length) finish(1);

// ---- Cross-document reference detection + version safety (A.5) --------------
const byId = new Map(manifestDocs.map(d => [d.document_id, d]));

// (a) Curator-declared references
for (const doc of admitted) {
  for (const ref of doc.declared_cross_references || []) {
    const target = byId.get(ref.target_document_id);
    const entry = {
      from_document_id: doc.document_id,
      to_document_id: ref.target_document_id,
      reference_kind: ref.reference_kind,
      required_version: ref.required_version,
      available_version: target ? target.version_normalized : null,
      status: 'UNRESOLVED',
      note: ref.note || null,
    };
    if (!target) {
      entry.status = 'TARGET_ABSENT';
      block('CROSS_REF_TARGET_ABSENT',
        `References ${ref.target_document_id} v${ref.required_version}, which is not in the ingested set. The mapping is left unresolved rather than substituted.`,
        { from: doc.document_id, to: ref.target_document_id });
    } else if (String(target.version_normalized) !== String(ref.required_version)) {
      entry.status = 'VERSION_MISMATCH';
      block('CROSS_REF_VERSION_MISMATCH',
        `Requires ${ref.target_document_id} v${ref.required_version} but the available source is v${target.version_normalized}. Silent substitution would produce confident citations pointing at unrelated content.`,
        { from: doc.document_id, to: ref.target_document_id, required: ref.required_version, available: target.version_normalized });
    } else {
      entry.status = 'RESOLVED';
    }
    report.cross_document_references.push(entry);
  }
}

// (b) Version strings observed in the text itself, matched against the corpus
// \b prevents matching the tail of words such as "cover"/"silver"; [ \t]* keeps the
// match on one line so a folio on the next line is never read as a version number.
const VERSION_IN_TEXT = /\b(?:publication[ \t]+version|version|ver\.)[ \t]*([0-9]+(?:\.[0-9]+)?)/gi;
const observedVersions = new Map();
for (const pm of pageMap) {
  let m;
  const re = new RegExp(VERSION_IN_TEXT.source, 'gi');
  while ((m = re.exec(pm.extracted_text))) {
    const key = `${pm.document_id}|${m[1]}`;
    if (!observedVersions.has(key)) observedVersions.set(key, { document_id: pm.document_id, version: m[1], first_page: pm.page_number, count: 0 });
    observedVersions.get(key).count++;
  }
}
for (const ov of observedVersions.values()) {
  const self = byId.get(ov.document_id);
  const isSelf = String(self.version_normalized) === String(ov.version);
  const matchesOther = manifestDocs.find(d => d.document_id !== ov.document_id && String(d.version_normalized) === String(ov.version));
  report.cross_document_references.push({
    from_document_id: ov.document_id,
    to_document_id: isSelf ? ov.document_id : (matchesOther ? matchesOther.document_id : null),
    reference_kind: isSelf ? 'self_version_statement' : 'observed_version_string',
    required_version: ov.version,
    available_version: isSelf ? self.version_normalized : (matchesOther ? matchesOther.version_normalized : null),
    status: isSelf ? 'RESOLVED_SELF' : (matchesOther ? 'RESOLVED' : 'UNMATCHED_VERSION_STRING'),
    first_seen_page: ov.first_page,
    occurrences: ov.count,
  });
  if (!isSelf && !matchesOther) {
    warn('UNMATCHED_VERSION_STRING', `A version string appears in the text but matches no ingested document. Curator should confirm whether a referenced document is missing.`,
      { document_id: ov.document_id, version: ov.version, first_page: ov.first_page });
  }
}

// (c) Page-index references: validate every cited page exists in the target
for (const doc of admitted) {
  const pageRef = (doc.declared_cross_references || []).find(r => r.reference_kind === 'page_reference_index');
  if (!pageRef) continue;
  const target = byId.get(pageRef.target_document_id);
  if (!target) continue;
  const cited = new Set();
  const malformed = [];
  for (const pm of pageMap.filter(p => p.document_id === doc.document_id)) {
    for (const line of pm.extracted_text.split('\n')) {
      const tail = line.match(/(?:\s|^)((?:\d{1,4}\s*,\s*)*\d{1,4})\s*$/);
      if (!tail) continue;
      if (!/^\s*\d+[\).]/.test(line.trim())) continue;   // only numbered checklist items
      for (const tok of tail[1].split(',').map(s => s.trim())) {
        if (/^0\d+/.test(tok)) malformed.push({ token: tok, page: pm.page_number });
        const n = parseInt(tok, 10);
        if (!Number.isNaN(n) && n > 0) cited.add(n);
      }
    }
  }
  const outOfRange = [...cited].filter(n => n > target.page_count);
  const inRange = [...cited].filter(n => n <= target.page_count);
  report.cross_document_references.push({
    from_document_id: doc.document_id,
    to_document_id: target.document_id,
    reference_kind: 'page_reference_index_validation',
    cited_pages_detected: cited.size,
    cited_pages_in_range: inRange.length,
    cited_pages_out_of_range: outOfRange,
    target_page_count: target.page_count,
    status: outOfRange.length ? 'OUT_OF_RANGE_REFERENCES' : 'RESOLVED',
  });
  if (outOfRange.length) {
    warn('PAGE_REF_OUT_OF_RANGE', `Checklist cites page numbers beyond the target document's page count. These references cannot be resolved and must not be presented as citations.`,
      { from: doc.document_id, to: target.document_id, pages: outOfRange.sort((a, b) => a - b) });
  }
  if (malformed.length) {
    warn('PAGE_REF_MALFORMED', `Malformed page-reference tokens (leading zero) found in source text. Parsed leniently but flagged for curator review.`,
      { from: doc.document_id, sample: malformed.slice(0, 6) });
  }
}

// ---- Corpus <-> curated configuration validation (A.5), both directions -----
const corpusText = pageMap.map(p => p.normalized_text).join(' ');
const modelsInCorpus = new Set();
for (const d of manifestDocs) for (const m of d.models_covered) modelsInCorpus.add(m);
// Normalized form for alias matching, so casing and spacing differences between the
// alias table and a document's models_covered do not read as an absent model.
const normalizedModelsInCorpus = new Set([...modelsInCorpus].map(normalize));

for (const m of modelsInCorpus) {
  const hasAlias = (aliasTable.models || []).some(a => a.canonical_model_name === m || (a.document_designation === m));
  if (!hasAlias) report.corpus_config_validation.documents_without_alias_entry.push(m);
}
for (const a of aliasTable.models || []) {
  // Two independent signals of coverage. The curated one is authoritative: an
  // alias is covered when a document's curated models_covered names it, whether
  // or not the name survives text extraction. A graphical cover page - the 430
  // Scuderia owner's manual, for instance - exposes no extractable model name,
  // so a text-only check would report a correctly scoped document as uncovered
  // and invite an unnecessary edit to the alias table.
  //
  // The text scan is kept as a secondary signal, recorded for diagnostics only.
  const names = [a.canonical_model_name, a.document_designation].filter(Boolean).map(normalize);
  const curatedMatch = names.some(n => normalizedModelsInCorpus.has(n));
  const textMatch = names.some(n => corpusText.includes(n));

  if (!curatedMatch && !textMatch) {
    report.corpus_config_validation.aliases_without_document.push({
      model_id: a.model_id, canonical_model_name: a.canonical_model_name, document_designation: a.document_designation,
    });
  } else if (curatedMatch && !textMatch) {
    report.corpus_config_validation.aliases_covered_by_curation_only.push({
      model_id: a.model_id, canonical_model_name: a.canonical_model_name,
      note: 'Covered by a curated models_covered entry. The model name was not found in extracted text, which is expected for documents whose title page is graphical.',
    });
  }
}
if (report.corpus_config_validation.documents_without_alias_entry.length) {
  warn('MODEL_WITHOUT_ALIAS_ENTRY', `Corpus covers models that have no alias-table entry. Judges using common names for these models may receive an unnecessary "not covered" response.`,
    { models: report.corpus_config_validation.documents_without_alias_entry });
}
if (report.corpus_config_validation.aliases_without_document.length) {
  warn('ALIAS_WITHOUT_DOCUMENT', `Alias-table entries point at models that no ingested document covers, by either curated models_covered or extracted text. Expected while the corpus is small; the alias table must not be silently rewritten.`,
    { entries: report.corpus_config_validation.aliases_without_document });
}
if (!(mappingTable.mappings || []).length) {
  report.corpus_config_validation.unmapped_note =
    'Score-sheet mapping table is empty. Per Addendum A.10, no score-sheet line and no maximum deduction may be displayed for any component until a score sheet is ingested and mappings are curated.';
  warn('NO_SCORE_SHEET_MAPPINGS', report.corpus_config_validation.unmapped_note);
}

// ---- Transcription vocabulary (A.14) - NOT aliases --------------------------
const vocabulary = [...vocabCounts.entries()]
  .filter(([, c]) => c >= VOCAB_MIN_FREQ)
  .sort((a, b) => b[1] - a[1])
  .slice(0, VOCAB_MAX_TERMS)
  .map(([term, count]) => ({ term, occurrences: count }));

writeFileSync(path.join(OUT, 'transcription-vocabulary.json'), JSON.stringify({
  _comment: 'A.14: pronunciation hints for the transcription model ONLY. Harvested terminology may become transcription vocabulary WITHOUT becoming curated aliases. There is no path from this artifact to config/model-aliases.json.',
  brand: BRAND, generated_at: report.run_at, min_frequency: VOCAB_MIN_FREQ, term_count: vocabulary.length, terms: vocabulary,
}, null, 2));

// ---- Write artifacts --------------------------------------------------------
writeFileSync(path.join(OUT, 'page-map.json'), JSON.stringify({
  _comment: 'A.6: retained even though retrieval is page-level. Used for citation validation, ingestion diagnostics, regression testing, and verification after document replacement.',
  brand: BRAND, generated_at: report.run_at, page_count: pageMap.length, pages: pageMap,
}, null, 2));

writeFileSync(path.join(OUT, 'document-manifest.json'), JSON.stringify({
  _comment: 'GENERATED counterpart to curated config/source-index.json. Ingestion validates curated metadata; it never decides it.',
  brand: BRAND, generated_at: report.run_at, corpus_status: sourceIndex.corpus_status,
  slice_threshold_bytes: SLICE_THRESHOLD_BYTES, documents: manifestDocs,
}, null, 2));

writeFileSync(path.join(OUT, 'retrieval-units.json'), JSON.stringify({
  _comment: 'Unit index. overlap_span is stored verbatim with overlap_origin_page so the citation resolver can run an exact substring containment test (A.6). Overlap never changes page attribution.',
  brand: BRAND, generated_at: report.run_at, overlap_chars: OVERLAP_CHARS, unit_count: retrievalUnits.length, units: retrievalUnits,
}, null, 2));

report.totals = {
  documents_admitted: manifestDocs.length,
  documents_excluded: sourceIndex.documents.length - manifestDocs.length,
  total_pages: totalPages,
  retrieval_units_generated: retrievalUnits.length,
  page_slices_generated: totalSlices,
  page_slice_bytes: totalSliceBytes,
  vocabulary_terms: vocabulary.length,
  warnings: report.warnings.length,
  blocking_errors: report.blocking_errors.length,
};

finish(report.blocking_errors.length ? 1 : 0);

function finish(code) {
  report.status = code === 0 ? (report.warnings.length ? 'PASSED_WITH_WARNINGS' : 'PASSED') : 'BLOCKED';
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'ingestion-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status, totals: report.totals,
    warnings: report.warnings.map(w => w.code),
    blocking_errors: report.blocking_errors.map(b => `${b.code}: ${b.message}`),
  }, null, 2));
  process.exit(code);
}
