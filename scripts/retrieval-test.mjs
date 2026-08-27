#!/usr/bin/env node
/**
 * Live retrieval smoke test.
 *
 * Confirms one thing only: a text question reaches the brand vector store, returns
 * approved-source content, and resolves to a VERIFIED page that View Exact Source
 * can open. It does not build product behaviour and does not judge anything.
 *
 * Env: OPENAI_API_KEY, OPENAI_VECTOR_STORE_ID_FERRARI, [OPENAI_MODEL]
 * Usage: node scripts/retrieval-test.mjs ["question"]
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCitation } from '../src/services/citation-resolver.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BRAND = 'ferrari';
const B = path.join(ROOT, 'build', BRAND);

const brandCfg = JSON.parse(readFileSync(path.join(ROOT, 'config/brands.json'), 'utf8')).brands[BRAND];
const KEY = process.env.OPENAI_API_KEY;
const STORE = process.env[brandCfg.vector_store_env_var];
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
if (!KEY || !STORE) { console.error('BLOCKED: OPENAI_API_KEY and OPENAI_VECTOR_STORE_ID_FERRARI must be set.'); process.exit(2); }

const units = JSON.parse(readFileSync(path.join(B, 'retrieval-units.json'), 'utf8')).units;
const manifest = JSON.parse(readFileSync(path.join(B, 'document-manifest.json'), 'utf8')).documents;
const unitById = new Map(units.map(u => [u.unit_id, u]));
const unitByFile = new Map(units.map(u => [u.unit_file, u]));
const docById = new Map(manifest.map(d => [d.document_id, d]));

const question = process.argv.slice(2).find(a => !a.startsWith('--'))
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
    tools: [{ type: 'file_search', vector_store_ids: [STORE], max_num_results: 8 }],
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
