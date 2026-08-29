#!/usr/bin/env node
/**
 * Apply curator decisions to the Batch 1 skeleton.
 *
 * Three provenance classes, kept strictly separate:
 *
 *   CURATOR_DIRECTIVE  Stated explicitly by the curator in writing.
 *   INHERITED          Copied verbatim from config/source-index.json, where the
 *                      curator already completed the same document. Subject to a
 *                      checksum match at ingestion.
 *   CANDIDATE          Suggested by a filename token. NOT written into the real
 *                      field. Parked in _curator_candidates for accept/reject.
 *
 * A filename is not a document. Nothing in the CANDIDATE class is treated as fact.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BATCH = path.join(ROOT, 'config/source-index-batch1.json');
const PROD = path.join(ROOT, 'config/source-index.json');
const PROD_CORPUS = path.join(ROOT, 'approved-source-docs');

const idx = JSON.parse(readFileSync(BATCH, 'utf8'));
const prod = JSON.parse(readFileSync(PROD, 'utf8'));

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const BASIS =
  'Curator-approved for private development and test-corpus use based on public availability '
  + 'through IAC/PFA. Not approved for production deployment. Ferrari Judging Committee '
  + 'confirmation pending.';

// ---- INHERITED: same document already curated in production -----------------
// Keyed batch id -> production id. Filenames differ for the As-Built (dot vs
// underscore), so the match is asserted by the curator and must be confirmed by
// checksum at ingestion, not assumed here.
const INHERIT = {
  'ferrari-iac-pfa-judging-guidelines': 'iacpfa-judging-guidelines',
  'ferrari-330-gtc-gts-concours-judging-checklist-ver-1': 'ferrari-330-gtc-gts-checklist',
  'ferrari-330-gtc-gts-as-built-configuration-and-judging-notes-document-version-8':
    'ferrari-330-gtc-gts-as-built',
};

const INHERIT_FIELDS = [
  'display_title', 'document_version', 'version_normalized', 'publication_date',
  'effective_year', 'source_organization', 'display_description',
];

// ---- CANDIDATE: filename tokens only ----------------------------------------
const CANDIDATES = {
  'ferrari-iac-pfa-decisions-15-february-2025': {
    publication_date: '2025-02-15',
    effective_year: 2025,
    source_organization: 'IAC/PFA',
    basis: 'Filename contains "15-February-2025" and the "IAC-PFA" prefix.',
  },
  'ferrari-as-built-checklist-for-ferrari-330-gtc-gts-version-9': {
    document_version: '9',
    version_normalized: '9',
    source_organization: 'IAC/PFA',
    basis: 'Filename contains "Version-9". Organization inferred from document family, NOT stated in filename.',
  },
  'ferrari-458-italia-carrozzeria-scaglietti-july-2010': {
    publication_date: '2010-07-01',
    effective_year: 2010,
    basis: 'Filename contains "July-2010". Day of month unknown; first of month is a placeholder, not a fact.',
  },
  'ferrari-458-italia-carrozzeria-sacglietti-jan-2011': {
    publication_date: '2011-01-01',
    effective_year: 2011,
    basis: 'Filename contains "Jan-2011". Day of month unknown. Note filename misspells "Scaglietti".',
  },
  'ferrari-semiar-for-judges-2026-2': {
    effective_year: 2026,
    basis: 'Filename contains "2026". Note filename misspells "Seminar".',
  },
};

// ---- Explicitly REFUSED derivations -----------------------------------------
const REFUSED = {
  'ferrari-ferrari-f8-tributo-communication-2019-10-05-21-09-21-utc':
    'Filename carries "2019_10_05-21_09_21-UTC", which is an export/save timestamp pattern, '
    + 'not a stated publication date. Refused as a date source.',
  'ferrari-26-09-16-gtc4-lusso-t-eng-1':
    'Filename begins "26_09_16", ambiguous between DD_MM_YY and YY_MM_DD. Refused as a date source.',
  'ferrari-documenting-your-new-er-fer': 'Filename is truncated mid-word. No reliable title or author.',
  'ferrari-ferrari-preservation-class-p': 'Filename is truncated mid-word. No reliable title.',
  'ferrari-judging-newer-ferraris-eich': 'Filename is truncated; trailing token appears to be a partial author surname.',
  'ferrari-judging-older-ferraris-leyd': 'Filename is truncated; trailing token appears to be a partial author surname.',
  'ferrari-f430-sp': '"SP" is expanded only by the batch manifest, not by the filename or any seen document text.',
  'ferrari-owners-manual-430-scuderia-eng': 'No date or version token present in the filename.',
};

const prodById = new Map(prod.documents.map(d => [d.document_id, d]));

let inherited = 0, candidates = 0, refused = 0;

for (const doc of idx.documents) {
  // CURATOR_DIRECTIVE — applies to all 16 without exception.
  doc.redistribution_status = 'approved';
  doc.redistribution_basis = BASIS;

  const prov = { curator_directive: ['redistribution_status', 'redistribution_basis'] };

  const src = INHERIT[doc.document_id] && prodById.get(INHERIT[doc.document_id]);
  if (src) {
    for (const f of INHERIT_FIELDS) if (src[f] != null) doc[f] = src[f];
    prov.inherited_from = src.document_id;
    prov.inherited_fields = INHERIT_FIELDS.filter(f => src[f] != null);
    // Embed the production file's checksum so ingestion can PROVE the "same
    // document" assertion instead of trusting it. The Batch 1 As-Built filename
    // differs from production's by one character (8.0 vs 8_0), which is exactly
    // the kind of near-match that deserves verification rather than assumption.
    const prodPdf = path.join(PROD_CORPUS, src.filename);
    if (existsSync(prodPdf)) {
      doc.expected_source_checksum = sha256(readFileSync(prodPdf));
      prov.inherit_verification =
        'Curator asserts this is the same document already curated in production. '
        + 'expected_source_checksum is the SHA-256 of the production file; ingestion warns '
        + 'INHERITED_CHECKSUM_MISMATCH if the Batch 1 file differs.';
    } else {
      prov.inherit_verification =
        'Curator assertion UNVERIFIED — the production PDF was not present to checksum.';
    }
    inherited++;
  }

  if (CANDIDATES[doc.document_id]) {
    const { basis, ...fields } = CANDIDATES[doc.document_id];
    doc._curator_candidates = { basis, proposed: fields, status: 'UNACCEPTED' };
    candidates++;
  }

  if (REFUSED[doc.document_id]) {
    doc._derivation_refused = REFUSED[doc.document_id];
    refused++;
  }

  const outstanding = ['display_title', 'document_version', 'publication_date', 'effective_year',
    'source_organization', 'display_description'].filter(f => doc[f] == null);
  if (outstanding.length) doc._curator_todo = outstanding;
  else delete doc._curator_todo;

  doc._field_provenance = prov;
}

idx._comment = [
  'CURATOR-OWNED INPUT (Addendum A.2 Tier 2, A.8). PARTIALLY COMPLETE.',
  'redistribution_status and redistribution_basis are curator directives, applied to all 16.',
  'Three documents inherit metadata already curated in production; ingestion must confirm the',
  'match by checksum. Everything else remains null: the PDFs were not readable at authoring time,',
  'and a filename is not a document. Proposed values sit unapplied in _curator_candidates.',
];
idx.last_updated = new Date().toISOString().slice(0, 10);

writeFileSync(BATCH, JSON.stringify(idx, null, 2));

const complete = idx.documents.filter(d => !d._curator_todo).length;
console.log(`approved:              ${idx.documents.length}/16`);
console.log(`inherited metadata:    ${inherited}`);
console.log(`candidate sets parked: ${candidates}`);
console.log(`derivations refused:   ${refused}`);
console.log(`fully complete:        ${complete}/16`);
console.log(`still need document text: ${16 - complete}`);
