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
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const BRAND = (args.indexOf('--brand') >= 0 ? args[args.indexOf('--brand') + 1] : 'ferrari');
const DRY = args.includes('--dry-run');
const PRUNE = args.includes('--prune');
const API = 'https://api.openai.com/v1';

const brandCfg = JSON.parse(readFileSync(path.join(ROOT, 'config/brands.json'), 'utf8')).brands[BRAND];
const KEY = process.env.OPENAI_API_KEY;
const STORE = process.env[brandCfg.vector_store_env_var];

// ---- Protected store guard --------------------------------------------------
// The live 330 GTC beta serves from the production store. Test and batch work must
// never reach it. The guard fires on the RESOLVED store id rather than on the brand
// name, because the realistic accident is a test environment variable holding the
// production value — a check on brand alone would not catch that.
const PROTECTED_STORE_IDS = Object.freeze([
  'vs_6a8f919ffd2c81919bebd21f9734fa4e',   // production Ferrari, live 330 GTC beta
]);
const PROTECTED_BRANDS = Object.freeze(['ferrari']);

if (STORE && PROTECTED_STORE_IDS.includes(STORE) && !PROTECTED_BRANDS.includes(BRAND)) {
  console.error(
    `BLOCKED: ${brandCfg.vector_store_env_var} resolves to ${STORE}, which is a PROTECTED production `
    + `vector store, but --brand is "${BRAND}".\n`
    + `Refusing to write. Point ${brandCfg.vector_store_env_var} at the test store and re-run.`,
  );
  process.exit(2);
}

const B = path.join(ROOT, 'build', BRAND);

/**
 * Load everything the run needs. Deferred out of module scope so this file can be
 * imported by tests without demanding credentials or a completed build.
 */
function loadRunState() {
  if (!KEY) fatal(`OPENAI_API_KEY is not set.`);
  if (!STORE) fatal(`${brandCfg.vector_store_env_var} is not set.`);

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

  // Curated source index (Tier 2). Scope and model coverage are editorial facts the
  // curator owns; they are read here, never derived.
  const curated = new Map(
    JSON.parse(readFileSync(path.join(ROOT, brandCfg.source_index), 'utf8'))
      .documents.map(d => [d.document_id, d]),
  );

  return { units, manifest, activeDocs, curated };
}

// ---- Retrieval attributes ---------------------------------------------------
// OpenAI allows at most 16 attributes per file, values limited to string, number
// or boolean. Current maximum below is 13.
export const MAX_ATTRIBUTES = 16;

/**
 * Build the vector-store attributes for one page-level unit.
 *
 * Page identity attributes are unchanged — they are the citation trust anchor.
 *
 * Nullable fields are OMITTED rather than stringified. `String(null)` yields the
 * text "null", which would then be a filterable attribute value and would appear
 * as real metadata; the same reason ingestion now omits the corresponding header
 * line rather than writing "Document version: null".
 *
 * @param {object} u       retrieval unit
 * @param {object} [doc]   curated source-index entry for the unit's document
 */
export function buildAttributes(u, doc) {
  const attributes = {
    unit_id: u.unit_id,
    document_id: u.document_id,
    document_title: String(u.document_title).slice(0, 300),
    page_number: u.page_number,
    brand: u.brand,
    source_type: u.source_type,
    superseded_status: u.superseded_status,
  };

  const version = u.document_version;
  if (version != null && String(version).trim() !== '' && String(version) !== 'null') {
    attributes.document_version = String(version);
  }

  if (u.section_heading) attributes.section_heading = String(u.section_heading).slice(0, 300);
  if (u.effective_year) attributes.effective_year = u.effective_year;

  // ---- Model isolation ----
  // These let retrieval separate a variant from its family: the 430 Scuderia
  // owner's manual must not answer as standard F430 documentation.
  const notes = [];
  if (doc) {
    if (doc.scope) attributes.scope = String(doc.scope);
    if (doc.model_family) attributes.model_family = String(doc.model_family);

    const covered = Array.isArray(doc.models_covered) ? doc.models_covered : [];
    if (covered.length === 1) {
      attributes.model_coverage = String(covered[0]);
    } else if (covered.length > 1) {
      // A comma-joined value would be an ambiguous filter key that matches neither
      // model exactly. Leave it unset and surface the condition for the curator.
      notes.push({
        document_id: u.document_id,
        models_covered: covered,
        detail: 'model_coverage left unset: multiple coverage values cannot be expressed as one unambiguous filter value.',
      });
    }
  }

  const count = Object.keys(attributes).length;
  if (count > MAX_ATTRIBUTES) {
    throw new Error(`${u.unit_id}: ${count} attributes exceeds the ${MAX_ATTRIBUTES}-attribute limit`);
  }
  for (const [k, v] of Object.entries(attributes)) {
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') {
      throw new Error(`${u.unit_id}: attribute "${k}" has unsupported type ${t}`);
    }
  }

  return { attributes, notes };
}

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
  const { units, activeDocs, curated } = loadRunState();
  const multiCoverage = [];
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
    if (DRY) {
      // Build attributes even on a dry run so limit or type faults surface here
      // rather than partway through a live upload.
      const { notes } = buildAttributes(u, curated.get(u.document_id));
      for (const n of notes) if (!multiCoverage.some(x => x.document_id === n.document_id)) multiCoverage.push(n);
      uploaded++; continue;
    }

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
      const { attributes, notes } = buildAttributes(u, curated.get(u.document_id));
      for (const n of notes) if (!multiCoverage.some(x => x.document_id === n.document_id)) multiCoverage.push(n);

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
    multi_coverage_documents: multiCoverage,
  };
  writeFileSync(path.join(B, 'upload-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(failed ? 1 : 0);
};

// Run only when invoked directly, so tests may import buildAttributes.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => fatal(e.message));
}
