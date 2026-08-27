#!/usr/bin/env node
/**
 * Vector Store Upload - stage 2 of ingestion.
 *
 * Deliberately separate from scripts/ingest.mjs: ingestion must be runnable and
 * verifiable with no network and no OpenAI spend. This stage only runs once
 * ingestion has PASSED.
 *
 * Page identity travels as vector-store file ATTRIBUTES. It is never reconstructed
 * from retrieved text at runtime (A.6).
 *
 * Env: OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID_FERRARI
 * Usage: node scripts/upload-vector-store.mjs [--brand ferrari] [--dry-run] [--prune]
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const BRAND = (args.indexOf('--brand') >= 0 ? args[args.indexOf('--brand') + 1] : 'ferrari');
const DRY = args.includes('--dry-run');
const PRUNE = args.includes('--prune');
const API = 'https://api.openai.com/v1';

const brandCfg = JSON.parse(readFileSync(path.join(ROOT, 'config/brands.json'), 'utf8')).brands[BRAND];
const KEY = process.env.OPENAI_API_KEY;
const STORE = process.env[brandCfg.vector_store_env_var];

if (!KEY) fatal(`OPENAI_API_KEY is not set.`);
if (!STORE) fatal(`${brandCfg.vector_store_env_var} is not set.`);

const B = path.join(ROOT, 'build', BRAND);
const reportPath = path.join(B, 'ingestion-report.json');
if (!existsSync(reportPath)) fatal(`No ingestion report at ${reportPath}. Run scripts/ingest.mjs first.`);

const ingestion = JSON.parse(readFileSync(reportPath, 'utf8'));
// Gate: never upload from a blocked ingestion run.
if (ingestion.status === 'BLOCKED' || ingestion.blocking_errors.length) {
  fatal(`Ingestion status is ${ingestion.status} with ${ingestion.blocking_errors.length} blocking error(s). Upload refused.`);
}

const units = JSON.parse(readFileSync(path.join(B, 'retrieval-units.json'), 'utf8')).units;
const manifest = JSON.parse(readFileSync(path.join(B, 'document-manifest.json'), 'utf8')).documents;
const activeDocs = new Set(manifest.filter(d => d.active && d.redistribution_status === 'approved').map(d => d.document_id));

function fatal(m) { console.error(`BLOCKED: ${m}`); process.exit(2); }
const H = { Authorization: `Bearer ${KEY}` };

async function api(method, url, body, extraHeaders = {}) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...H, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
    body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined),
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function listStoreFiles() {
  const out = [];
  let after = null;
  do {
    const page = await api('GET', `/vector_stores/${STORE}/files?limit=100${after ? `&after=${after}` : ''}`);
    out.push(...page.data);
    after = page.has_more ? page.last_id : null;
  } while (after);
  return out;
}

const main = async () => {
  console.log(`Brand ${BRAND} | store ${STORE} | ${units.length} units | ${DRY ? 'DRY RUN' : 'LIVE'}`);

  const existing = await listStoreFiles();
  const existingByUnit = new Map();
  const staleByUnit = new Map();
  for (const f of existing) {
    const uid = f.attributes?.unit_id;
    if (!uid) continue;
    // A file that ended in `failed` or `cancelled` is attached but NOT searchable.
    // Treating it as present would make the gap permanently unrepairable, because
    // every re-run would skip it. Mark it stale so it is replaced.
    if (f.status === 'failed' || f.status === 'cancelled') staleByUnit.set(uid, f);
    else existingByUnit.set(uid, f);
  }
  const statusCounts = existing.reduce((a, f) => ({ ...a, [f.status]: (a[f.status] || 0) + 1 }), {});
  console.log(`Existing files in store: ${existing.length} ${JSON.stringify(statusCounts)}`);
  console.log(`  usable: ${existingByUnit.size} | stale (failed/cancelled, will be replaced): ${staleByUnit.size}`);

  let uploaded = 0, skipped = 0, failed = 0, pruned = 0, replaced = 0;
  const failures = [];

  for (const u of units) {
    if (!activeDocs.has(u.document_id)) { skipped++; continue; }
    if (existingByUnit.has(u.unit_id)) { skipped++; continue; }   // idempotent re-run
    if (DRY) { uploaded++; continue; }

    try {
      // Remove a previously failed attachment for this unit before replacing it.
      const stale = staleByUnit.get(u.unit_id);
      if (stale) { await api('DELETE', `/vector_stores/${STORE}/files/${stale.id}`); replaced++; }

      const filePath = path.join(B, 'retrieval-units', u.unit_file);
      const fd = new FormData();
      fd.append('purpose', 'assistants');
      fd.append('file', new Blob([readFileSync(filePath)], { type: 'text/markdown' }), u.unit_file);
      const file = await api('POST', '/files', fd);

      // Attributes are the authoritative page identity at retrieval time.
      const attributes = {
        unit_id: u.unit_id,
        document_id: u.document_id,
        document_title: String(u.document_title).slice(0, 300),
        document_version: String(u.document_version),
        page_number: u.page_number,
        brand: u.brand,
        source_type: u.source_type,
        superseded_status: u.superseded_status,
      };
      if (u.section_heading) attributes.section_heading = String(u.section_heading).slice(0, 300);
      if (u.effective_year) attributes.effective_year = u.effective_year;

      await api('POST', `/vector_stores/${STORE}/files`, {
        file_id: file.id,
        attributes,
        // One page per chunk: page identity must not be split across chunks.
        chunking_strategy: { type: 'static', static: { max_chunk_size_tokens: 4000, chunk_overlap_tokens: 0 } },
      });
      uploaded++;
      if (uploaded % 25 === 0) console.log(`  ...${uploaded} uploaded`);
    } catch (e) {
      failed++; failures.push({ unit_id: u.unit_id, error: e.message });
    }
  }

  if (PRUNE && !DRY) {
    const wanted = new Set(units.filter(u => activeDocs.has(u.document_id)).map(u => u.unit_id));
    for (const [uid, f] of existingByUnit) {
      if (!wanted.has(uid)) {
        await api('DELETE', `/vector_stores/${STORE}/files/${f.id}`);
        pruned++;
      }
    }
  }

  const result = {
    status: failed ? 'PARTIAL' : 'OK',
    dry_run: DRY,
    vector_store_id: STORE,
    units_in_build: units.length,
    uploaded, skipped_already_present: skipped, failed, pruned, replaced_stale: replaced,
    store_total_after: (await listStoreFiles()).length,
    note: 'store_total_after counts attached rows. Attachment is asynchronous, so a row may still be processing or may have failed. Run scripts/verify-vector-store.mjs for searchable counts.',
    failures: failures.slice(0, 10),
  };
  writeFileSync(path.join(B, 'upload-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(failed ? 1 : 0);
};

main().catch(e => fatal(e.message));
