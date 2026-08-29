#!/usr/bin/env node
/**
 * Live retrieval smoke test.
 *
 * Confirms one thing only: a text question reaches the brand vector store, returns
 * approved-source content, and resolves to a VERIFIED page that View Exact Source
 * can open. It does not build product behaviour and does not judge anything.
 *
 * Env: OPENAI_API_KEY, the brand's vector store variable, [OPENAI_MODEL]
 * Usage: node scripts/retrieval-test.mjs ["question"] [--brand ferrari] [--coverage "430 Scuderia"]
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCitation } from '../src/services/citation-resolver.mjs';
import { fileURLToPath } from 'node:url';

/**
 * Build the file_search tool block.
 *
 * Without a coverage value the block is byte-identical to the original: no filter
 * key is emitted at all, so the unfiltered path is unchanged.
 *
 * With one, retrieval is restricted to documents a judge standing at THAT car may
 * rely on: brand-wide material, plus material whose curated model_coverage matches
 * exactly. A 430 Scuderia question must not be answered from standard F430
 * documentation, which is why coverage is compared for equality rather than by
 * family. The value is the uploaded model_coverage attribute verbatim - no alias
 * resolution and no model-name inference happens here.
 *
 * @param {string} storeId
 * @param {string|null} [coverage]  exact model_coverage attribute value
 */
export function buildFileSearchTool(storeId, coverage) {
  const tool = { type: 'file_search', vector_store_ids: [storeId], max_num_results: 8 };
  if (coverage == null || String(coverage).trim() === '') return tool;
  tool.filters = {
    type: 'or',
    filters: [
      { type: 'eq', key: 'scope', value: 'brand_wide' },
      { type: 'eq', key: 'model_coverage', value: String(coverage) },
    ],
  };
  return tool;
}

const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const brandFlagIdx = args.indexOf('--brand');
const BRAND = brandFlagIdx >= 0 ? args[brandFlagIdx + 1] : 'ferrari';
const coverageFlagIdx = args.indexOf('--coverage');
const COVERAGE = coverageFlagIdx >= 0 ? args[coverageFlagIdx + 1] : null;
const B = path.join(ROOT, 'build', BRAND);

// Imported for testing: expose buildFileSearchTool without running the CLI.
if (IS_MAIN) {

  const brands = JSON.parse(readFileSync(path.join(ROOT, 'config/brands.json'), 'utf8')).brands;
  const brandCfg = brands[BRAND];
  if (!brandCfg) {
    console.error(`BLOCKED: unknown brand "${BRAND}". Known: ${Object.keys(brands).join(', ')}`);
    process.exit(2);
  }

  const KEY = process.env.OPENAI_API_KEY;
  const STORE = process.env[brandCfg.vector_store_env_var];
  const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';

  // Protected store guard, mirroring scripts/upload-vector-store.mjs. Retrieval is
  // read-only, but a test that silently queries production would report the wrong
  // corpus as proof the Batch 1 store works. Fires on the RESOLVED id, before any
  // API call, because the realistic accident is a test variable holding the
  // production value.
  const PROTECTED_STORE_IDS = Object.freeze([
    'vs_6a8f919ffd2c81919bebd21f9734fa4e',   // production Ferrari, live 330 GTC beta
  ]);
  const PROTECTED_BRANDS = Object.freeze(['ferrari']);
  if (STORE && PROTECTED_STORE_IDS.includes(STORE) && !PROTECTED_BRANDS.includes(BRAND)) {
    console.error(
      `BLOCKED: ${brandCfg.vector_store_env_var} resolves to ${STORE}, which is a PROTECTED production `
      + `vector store, but --brand is "${BRAND}".\n`
      + `Refusing to query. Point ${brandCfg.vector_store_env_var} at the test store and re-run.`,
    );
    process.exit(2);
  }

  if (!KEY || !STORE) { console.error(`BLOCKED: OPENAI_API_KEY and ${brandCfg.vector_store_env_var} must be set.`); process.exit(2); }

  const units = JSON.parse(readFileSync(path.join(B, 'retrieval-units.json'), 'utf8')).units;
  const manifest = JSON.parse(readFileSync(path.join(B, 'document-manifest.json'), 'utf8')).documents;
  const unitById = new Map(units.map(u => [u.unit_id, u]));
  const unitByFile = new Map(units.map(u => [u.unit_file, u]));
  const docById = new Map(manifest.map(d => [d.document_id, d]));

  // Flag VALUES do not start with "--", so each must be excluded explicitly or it
  // would be mistaken for the question.
  const flagValueIdx = new Set([brandFlagIdx + 1, coverageFlagIdx + 1].filter(i => i > 0));
  const question = args.find((a, i) => !a.startsWith('--') && !flagValueIdx.has(i))
    || 'On a 1967 330 GTC, what wheels and knock-off spinners are correct?';

  const started = Date.now();
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: [{
        role: 'user',
        content: `Answer only from the approved source documents. If they do not support an answer, say so.\n\nQuestion: ${question}`,
      }],
      tools: [buildFileSearchTool(STORE, COVERAGE)],
      include: ['file_search_call.results'],   // required: we resolve citations ourselves
      store: false,
    }),
  });
  if (!res.ok) { console.error(`ERROR ${res.status}: ${await res.text()}`); process.exit(1); }
  const data = await res.json();
  const durationMs = Date.now() - started;

  // Model prose is reported for context only. It is NOT the citation.
  const answerText = (data.output || [])
    .filter(o => o.type === 'message')
    .flatMap(o => o.content || [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text).join('\n').trim();

  const searchCalls = (data.output || []).filter(o => o.type === 'file_search_call');
  const results = searchCalls.flatMap(c => c.results || []);

  const citations = [];
  for (const r of results) {
    // Primary: authoritative unit_id carried as a vector-store file attribute.
    // Fallback: the uploaded filename, which ingestion derives from the unit id.
    // Either way the page is still proven by the citation resolver's containment
    // test below - neither path trusts a model-supplied page number.
    const unitId = r.attributes?.unit_id;
    let unit = unitId ? unitById.get(unitId) : null;
    let lookup = unit ? 'attribute' : null;
    if (!unit && r.filename) {
      unit = unitByFile.get(r.filename) || null;
      if (unit) lookup = 'filename_fallback';
    }
    if (!unit) {
      // A.6 / v1.0 §31: reject any source identifier not in the approved manifest.
      citations.push({ rejected: true, reason: 'source not resolvable to the approved manifest', raw_file_id: r.file_id, filename: r.filename || null });
      continue;
    }
    const doc = docById.get(unit.document_id);
    const probe = buildCitation({ unit, excerpt: r.text, manifestDoc: doc, sliceExists: true });
    const slice = probe.page_number !== null
      && existsSync(path.join(B, 'page-slices', unit.document_id, `p${String(probe.page_number).padStart(4, '0')}.pdf`));
    citations.push({ ...buildCitation({ unit, excerpt: r.text, manifestDoc: doc, sliceExists: slice }), score: r.score, lookup });
  }

  const verified = citations.filter(c => c.page_verified);
  const result = {
    question,
    model: MODEL,
    duration_ms: durationMs,          // A.4 instrumentation: text-only path
    retrieval_results: results.length,
    citations_verified: verified.length,
    citations_page_suppressed: citations.length - verified.length,
    top_verified_source: verified[0]
      ? {
          document: verified[0].display_title,
          document_id: verified[0].document_id,
          version: verified[0].document_version,
          verified_page: verified[0].page_number,
          resolution: verified[0].resolution,
          viewer_url: verified[0].viewer_url,
        }
      : null,
    all_citations: citations.map(c => c.rejected
      ? c
      : { document_id: c.document_id, page: c.page_number, verified: c.page_verified, resolution: c.resolution, lookup: c.lookup }),
    model_prose_for_context_only: answerText.slice(0, 700),
  };
  writeFileSync(path.join(B, 'retrieval-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  process.exit(verified.length ? 0 : 1);

}
