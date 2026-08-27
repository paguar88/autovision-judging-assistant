#!/usr/bin/env node
/**
 * Vector store verification.
 *
 * Answers one question with evidence: is every expected retrieval unit actually
 * present AND usable in the brand vector store? Names any that are not.
 *
 * "Uploaded" and "present" measure different things. The upload counter records
 * accepted POSTs. A vector-store file is then processed asynchronously and can end
 * in `failed`, at which point it is attached but NOT searchable. This script
 * reports processing status, not just row count.
 *
 * Env: OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID_FERRARI
 * Usage: node scripts/verify-vector-store.mjs [--brand ferrari] [--json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const BRAND = args.indexOf('--brand') >= 0 ? args[args.indexOf('--brand') + 1] : 'ferrari';
const API = 'https://api.openai.com/v1';

const brandCfg = JSON.parse(readFileSync(path.join(ROOT, 'config/brands.json'), 'utf8')).brands[BRAND];
const KEY = process.env.OPENAI_API_KEY;
const STORE = process.env[brandCfg.vector_store_env_var];
if (!KEY || !STORE) { console.error(`BLOCKED: OPENAI_API_KEY and ${brandCfg.vector_store_env_var} must be set.`); process.exit(2); }

const B = path.join(ROOT, 'build', BRAND);
const units = JSON.parse(readFileSync(path.join(B, 'retrieval-units.json'), 'utf8')).units;
const byFile = new Map(units.map(u => [u.unit_file, u]));

const req = async (url) => {
  const r = await fetch(`${API}${url}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// Paginate exhaustively. Guard against a silent pagination bug by counting pages
// and refusing to report a total we did not actually walk to the end of.
const files = [];
let after = null, pages = 0, truncated = false;
do {
  const page = await req(`/vector_stores/${STORE}/files?limit=100${after ? `&after=${after}` : ''}`);
  files.push(...page.data);
  pages++;
  after = page.has_more ? page.last_id : null;
  if (pages > 50) { truncated = true; break; }
} while (after);

const byStatus = {};
for (const f of files) byStatus[f.status] = (byStatus[f.status] || 0) + 1;

// Resolve each store file back to a unit. Attributes first, filename as fallback.
const seen = new Map();     // unit_id -> {status, file_id, last_error}
const unattributable = [];
for (const f of files) {
  let unitId = f.attributes?.unit_id || null;
  if (!unitId) {
    const meta = await req(`/files/${f.id}`).catch(() => null);
    const u = meta?.filename ? byFile.get(meta.filename) : null;
    unitId = u?.unit_id || null;
  }
  if (!unitId) { unattributable.push(f.id); continue; }
  seen.set(unitId, { status: f.status, file_id: f.id, last_error: f.last_error || null });
}

const usable = (s) => s === 'completed' || s === 'in_progress';
const missing = units.filter(u => !seen.has(u.unit_id));
const failed = units.filter(u => seen.has(u.unit_id) && !usable(seen.get(u.unit_id).status));
const searchable = units.filter(u => seen.has(u.unit_id) && seen.get(u.unit_id).status === 'completed');

const describe = (u) => {
  const primaryChars = (u.primary_text || '').trim().length;
  return {
    unit_id: u.unit_id,
    document_id: u.document_id,
    page_number: u.page_number,
    primary_text_chars: primaryChars,
    photo_only_page: primaryChars < 40,
    store_status: seen.get(u.unit_id)?.status || 'ABSENT',
    last_error: seen.get(u.unit_id)?.last_error || null,
  };
};

const result = {
  vector_store_id: STORE,
  units_expected: units.length,
  store_rows_returned: files.length,
  pages_walked: pages,
  pagination_truncated: truncated,
  by_status: byStatus,
  units_searchable: searchable.length,
  units_absent: missing.length,
  units_failed_processing: failed.length,
  unattributable_store_files: unattributable.length,
  absent: missing.map(describe),
  failed: failed.map(describe),
  by_document: Object.fromEntries(
    [...new Set(units.map(u => u.document_id))].map(d => [d, {
      expected: units.filter(u => u.document_id === d).length,
      searchable: searchable.filter(u => u.document_id === d).length,
    }])),
  verdict: missing.length === 0 && failed.length === 0 && !truncated
    ? 'COMPLETE - every expected unit is present and searchable'
    : 'INCOMPLETE - see absent/failed lists',
};

writeFileSync(path.join(B, 'verify-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(result.units_absent || result.units_failed_processing || truncated ? 1 : 0);
