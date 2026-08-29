#!/usr/bin/env node
/**
 * Source-index validator — offline, read-only.
 *
 * Answers one question: would ingestion accept this index, and what will it warn
 * about? It reproduces the gates ingest.mjs applies plus the metadata-quality
 * checks that only bite once a document reaches a judge's screen.
 *
 * No PDFs are opened, no network call is made, nothing is written.
 *
 * Usage: node scripts/validate-source-index.mjs [--brand ferrari-test]
 * Exit:  0 clean or warnings only, 2 blocking
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BRAND = (args.indexOf('--brand') >= 0 ? args[args.indexOf('--brand') + 1] : 'ferrari-test');

const brandCfg = JSON.parse(readFileSync(path.join(ROOT, 'config/brands.json'), 'utf8')).brands[BRAND];
if (!brandCfg) { console.error(`Unknown brand: ${BRAND}`); process.exit(2); }
const idx = JSON.parse(readFileSync(path.join(ROOT, brandCfg.source_index), 'utf8'));

const blocking = [], warnings = [], notes = [];
const B = (c, m) => blocking.push(`${c}: ${m}`);
const W = (c, m) => warnings.push(`${c}: ${m}`);

// ---- Gate 1: redistribution (reproduces ingest.mjs) -------------------------
for (const d of idx.documents) {
  const s = d.redistribution_status;
  if (s === 'approved') continue;
  if (s === 'not_approved') W('REDISTRIBUTION_EXCLUDED', `${d.document_id} will be skipped`);
  else B('REDISTRIBUTION_UNKNOWN', `${d.document_id} has status "${s ?? 'missing'}"`);
}

// ---- Gate 2: identity -------------------------------------------------------
const ids = idx.documents.map(d => d.document_id);
for (const id of new Set(ids)) {
  if (ids.filter(x => x === id).length > 1) B('DUPLICATE_DOCUMENT_ID', id);
}
// Batch indexes must not reuse a production document_id. Skipped when the index
// under validation IS the production index, which would otherwise self-collide.
if (brandCfg.source_index !== 'config/source-index.json') {
  const prodIds = new Set(JSON.parse(readFileSync(path.join(ROOT, 'config/source-index.json'), 'utf8'))
    .documents.map(d => d.document_id));
  for (const id of ids) if (prodIds.has(id)) B('ID_COLLIDES_WITH_PRODUCTION', id);
}

const paths = idx.documents.map(d => d.source_path || d.filename);
for (const p of new Set(paths)) {
  if (paths.filter(x => x === p).length > 1) B('DUPLICATE_SOURCE_PATH', p);
}

// ---- Gate 3: fields that reach the vector store or the judge ----------------
// ingest.mjs omits the version and organization header lines when they are null,
// so absent metadata is silence rather than the literal word "null". These remain
// worth reporting: a retrieval unit with no version line carries less context.
for (const d of idx.documents) {
  if (!d.display_title) B('MISSING_DISPLAY_TITLE', `${d.document_id} would emit "# null" into its retrieval units`);
  if (!d.document_version) W('NO_DOCUMENT_VERSION', `${d.document_id} — version line omitted from its retrieval unit headers`);
  if (!d.source_organization) W('NO_SOURCE_ORGANIZATION', `${d.document_id} — organization line omitted from its retrieval unit headers`);
  if (!d.display_description) W('MISSING_DISPLAY_DESCRIPTION', `${d.document_id} shows no description in the Source Documents list`);
  if (d.active !== true) W('INACTIVE_DOCUMENT', d.document_id);
}

// The omission above is a property of ingest.mjs, not of this index. If that guard
// is ever removed, these warnings become corpus defects, so assert it here.
{
  const src = readFileSync(path.join(ROOT, 'scripts/ingest.mjs'), 'utf8');
  for (const f of ['document_version', 'source_organization']) {
    if (!new RegExp(`doc\\.${f}\\s*\\?`).test(src)) {
      B('UNGUARDED_HEADER_FIELD',
        `ingest.mjs no longer guards ${f}; a null would be written into retrieval units as the text "null"`);
    }
  }
}

// ---- Date discipline --------------------------------------------------------
for (const d of idx.documents) {
  if (d.publication_date && !/^\d{4}-\d{2}-\d{2}$/.test(d.publication_date)) {
    B('MALFORMED_PUBLICATION_DATE', `${d.document_id}: ${d.publication_date}`);
  }
  // A month/year-only source must not carry a fabricated day.
  if (d.publication_date?.endsWith('-01') && /^[A-Z][a-z]+ \d{4}$/.test(d.document_version || '')) {
    B('FABRICATED_DAY_OF_MONTH', `${d.document_id} states only "${d.document_version}" but carries ${d.publication_date}`);
  }
  if (d.publication_date && d.effective_year
      && Number(d.publication_date.slice(0, 4)) !== d.effective_year) {
    W('DATE_YEAR_DISAGREEMENT', `${d.document_id}: ${d.publication_date} vs effective_year ${d.effective_year}`);
  }
}

// ---- Version relationships --------------------------------------------------
const byId = new Map(idx.documents.map(d => [d.document_id, d]));
for (const d of idx.documents) {
  for (const r of d.related_documents || []) {
    if (!byId.has(r)) B('DANGLING_RELATED_DOCUMENT', `${d.document_id} -> ${r}`);
  }
  for (const x of d.declared_cross_references || []) {
    const t = byId.get(x.target_document_id);
    if (!t) { B('DANGLING_CROSS_REFERENCE', `${d.document_id} -> ${x.target_document_id}`); continue; }
    if (x.required_version && t.document_version && x.required_version !== t.document_version) {
      B('CROSS_REFERENCE_VERSION_MISMATCH',
        `${d.document_id} requires ${x.target_document_id} v${x.required_version}, index has v${t.document_version}`);
    }
  }
  if (d.superseded_by && !byId.has(d.superseded_by)) B('DANGLING_SUPERSEDED_BY', d.document_id);
}
for (const f of idx._flags || []) W(f.code, f.detail);

// ---- Inheritance ------------------------------------------------------------
for (const d of idx.documents) {
  if (d._field_provenance?.inherited_from && !/^[0-9a-f]{64}$/.test(d.expected_source_checksum || '')) {
    W('UNVERIFIABLE_INHERITANCE', `${d.document_id} inherits metadata with no checksum to verify against`);
  }
}

// ---- Leftover bookkeeping ---------------------------------------------------
for (const d of idx.documents) {
  if (d._curator_candidates) W('UNRESOLVED_CANDIDATE', d.document_id);
  if (d._curator_todo?.length) notes.push(`${d.document_id} — unset: ${d._curator_todo.join(', ')}`);
}

// ---- Report -----------------------------------------------------------------
const pages = idx.documents.reduce((n, d) => n + (d.declared_page_count || 0), 0);
console.log(`\nSource index validation — brand "${BRAND}"`);
console.log(`  index:      ${brandCfg.source_index}`);
console.log(`  documents:  ${idx.documents.length}   declared pages: ${pages}`);
console.log(`  excluded:   ${(idx._excluded_from_batch || []).length}`);

const show = (title, arr) => {
  console.log(`\n${title} (${arr.length})`);
  if (!arr.length) console.log('  none');
  else arr.forEach(x => console.log(`  - ${x}`));
};

show('BLOCKING', blocking);
show('WARNINGS', warnings);
if (notes.length) show('Fields still unset (not blocking)', notes);

console.log(`\n${blocking.length ? 'NOT INGESTION-READY' : 'INGESTION-READY'}`
  + `  —  ${blocking.length} blocking, ${warnings.length} warning(s)`);
console.log('Validation only. Nothing was ingested and nothing was uploaded.\n');

process.exit(blocking.length ? 2 : 0);
