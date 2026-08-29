#!/usr/bin/env node
/**
 * Batch manifest -> curated source-index SKELETON.
 *
 * Addendum A.5 draws a hard line through this file. Ingestion may extract
 * mechanical facts; it must never generate editorial ones. So:
 *
 *   DERIVED HERE  document_id, filename, source_path, page_count, scope,
 *                 models_covered, source_type, brand
 *
 *   LEFT BLANK    redistribution_status, redistribution_basis, display_title,
 *                 document_version, publication_date, effective_year,
 *                 source_organization, supersedes, superseded_by,
 *                 display_description
 *
 * Blank editorial fields are emitted as null, not guessed. redistribution_status
 * is emitted as null deliberately: ingest.mjs treats null as REDISTRIBUTION_UNKNOWN
 * and hard-blocks the run. The skeleton therefore cannot be ingested by accident
 * before the curator has completed it. That is the intended behaviour, not a bug.
 *
 * Usage: node build-batch-index.mjs <manifest.json> [--out <path>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const manifestPath = args.find(a => !a.startsWith('--'));
const outPath = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : 'source-index-batch1.json';

if (!manifestPath) {
  console.error('Usage: node build-batch-index.mjs <manifest.json> [--out <path>]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// ---- document_id derivation -------------------------------------------------
// Stable, deterministic, human-readable. Derived from the filename stem so that
// re-running this translator on the same manifest always yields the same ids —
// ids appear in citations and in vector-store attributes, so they must not drift.
function deriveId(record) {
  const stem = path.basename(record.source_path, '.pdf');
  const slug = stem
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 72)
    .replace(/-+$/, '');   // truncation must not leave a dangling separator
  return `ferrari-${slug}`;
}

// ---- scope mapping ----------------------------------------------------------
// The batch manifest's vocabulary differs from source-index.json's. Map it
// explicitly rather than passing the raw string through.
const SCOPE_MAP = {
  shared: 'brand_wide',
  model: 'model_specific',
  variant: 'model_specific',
};

// ---- models_covered ---------------------------------------------------------
// "ALL" in the batch manifest means brand-wide, which source-index.json expresses
// as an empty array (see the production entry for the IAC/PFA guidelines).
function modelsCovered(record) {
  if (!record.model || record.model === 'ALL') return [];
  return [record.model];
}

const ingested = manifest.records.filter(r => r.ingest === true);
const excluded = manifest.records.filter(r => r.ingest !== true);

const seen = new Map();
const documents = ingested.map(record => {
  const document_id = deriveId(record);
  if (seen.has(document_id)) {
    console.error(`FATAL: duplicate document_id "${document_id}" from ${record.source_path} and ${seen.get(document_id)}`);
    process.exit(1);
  }
  seen.set(document_id, record.source_path);

  return {
    document_id,
    filename: path.basename(record.source_path),
    source_path: record.source_path,
    display_title: null,
    document_version: null,
    version_normalized: null,
    publication_date: null,
    effective_year: null,
    source_organization: null,
    source_type: record.document_type,
    scope: SCOPE_MAP[record.scope] ?? record.scope,
    models_covered: modelsCovered(record),
    model_family: record.model_family,
    brand: 'ferrari',
    redistribution_status: null,
    redistribution_basis: null,
    active: true,
    supersedes: null,
    superseded_by: null,
    related_documents: [],
    declared_cross_references: [],
    display_description: null,
    declared_page_count: record.pages,
    notes: record.note ?? null,
    _curator_todo: [
      'redistribution_status',
      'display_title',
      'document_version',
      'source_organization',
      'display_description',
    ],
  };
});

// ---- v8.0 / v9 relationship -------------------------------------------------
// Recorded as a related_documents link only. Per the curator's instruction both
// remain active and neither is marked superseded; the relationship is FLAGGED,
// not resolved. supersedes/superseded_by stay null for the curator to decide.
const asBuilt = documents.find(d => /as-built-configuration/.test(d.document_id));
const checklistV9 = documents.find(d => /as-built-checklist/.test(d.document_id));
const checklistV1 = documents.find(d => /concours-judging-checklist/.test(d.document_id));

const flags = [];
if (asBuilt && checklistV9) {
  asBuilt.related_documents.push(checklistV9.document_id);
  checklistV9.related_documents.push(asBuilt.document_id);
  flags.push({
    code: 'VERSION_RELATIONSHIP_UNRESOLVED',
    document_ids: [asBuilt.document_id, checklistV9.document_id],
    detail: 'As-Built Configuration v8.0 and As-Built Checklist Version 9 both present and both active. '
          + 'Linked as related documents. supersedes/superseded_by left null pending a curator decision (A.8).',
  });
}
if (asBuilt && checklistV1) {
  asBuilt.related_documents.push(checklistV1.document_id);
  checklistV1.related_documents.push(asBuilt.document_id);
  checklistV1.declared_cross_references.push({
    target_document_id: asBuilt.document_id,
    required_version: '8.0',
    required_publication: 'July 2023',
    reference_kind: 'page_reference_index',
    note: 'Carried forward from the production source-index. Checklist line items carry trailing '
        + 'page numbers indexing into the As-Built document; page attribution depends on the '
        + 'referenced version being exactly 8.0.',
  });
}

const out = {
  _comment: [
    'CURATOR-OWNED INPUT (Addendum A.2 Tier 2, A.8). SKELETON — NOT YET COMPLETE.',
    'Mechanically derived from Ferrari-Source-Manifest-Batch-1.json. Every null field is a',
    'curator decision that software must not make. redistribution_status is null on every',
    'document, so ingest.mjs will BLOCK this file until it is completed. That is intended.',
    'Remove each _curator_todo array as its fields are filled.',
  ],
  schema_version: '1.0',
  brand: 'ferrari',
  corpus_status: 'test',
  corpus_status_note:
    'Batch 1 test corpus. NOT the production corpus and NOT the Ferrari Judging Committee '
    + 'approved production set. Ingested to a separate test vector store under brand key '
    + '"ferrari-test". The live 330 GTC beta is unaffected.',
  curator: 'Autovision Studios',
  last_updated: new Date().toISOString().slice(0, 10),
  derived_from: path.basename(manifestPath),
  documents,
  _excluded_from_batch: excluded.map(r => ({
    source_path: r.source_path,
    reason: r.skip_reason ?? 'ingest flag false',
  })),
  _flags: flags,
};

writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`Wrote ${outPath}`);
console.log(`  documents:        ${documents.length}`);
console.log(`  excluded:         ${excluded.length}`);
console.log(`  declared pages:   ${documents.reduce((n, d) => n + (d.declared_page_count || 0), 0)}`);
console.log(`  flags:            ${flags.length}`);
console.log(`  curator fields blank on every document — ingestion will block until completed.`);
