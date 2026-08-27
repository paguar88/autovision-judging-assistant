#!/usr/bin/env node
/**
 * Renders the Stage 1 milestone report from whatever artifacts exist.
 * Writes markdown to stdout. Never throws on missing files - a partial run
 * should still produce a readable report.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const B = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../build/ferrari');
const load = (f) => { try { return existsSync(path.join(B, f)) ? JSON.parse(readFileSync(path.join(B, f), 'utf8')) : null; } catch { return null; } };

const ing = load('ingestion-report.json');
const up = load('upload-result.json');
const ret = load('retrieval-result.json');
const mask = (id) => (id ? `${String(id).slice(0, 11)}…${String(id).slice(-4)}` : 'not recorded');

const L = [];
L.push('# Ferrari Stage 1 Milestone Report', '');

L.push('## Chain status', '');
const chain = [
  ['Ingestion', ing ? (ing.blocking_errors?.length ? 'BLOCKED' : ing.status) : 'not run'],
  ['Upload', up ? (up.dry_run ? 'DRY RUN ONLY' : up.status) : 'not run'],
  ['Live retrieval', ret ? (ret.citations_verified > 0 ? 'VERIFIED' : 'NO VERIFIED CITATION') : 'not run'],
];
L.push('| Stage | Result |', '|---|---|', ...chain.map(([a, b]) => `| ${a} | **${b}** |`), '');

L.push('## Requested report items', '');
L.push('| Item | Value |', '|---|---|');
L.push(`| Retrieval units uploaded | ${up ? (up.dry_run ? `${up.uploaded} planned (dry run, nothing written)` : up.uploaded) : 'n/a'} |`);
L.push(`| Units present in build | ${up?.units_in_build ?? ing?.totals?.retrieval_units_generated ?? 'n/a'} |`);
L.push(`| Vector store total after run | ${up?.store_total_after ?? 'n/a'} |`);
L.push(`| Vector store ID used | \`${mask(up?.vector_store_id ?? ret?.vector_store_id)}\` |`);
L.push(`| Upload success/failure | ${up ? `${up.status} — ${up.uploaded} uploaded, ${up.skipped_already_present} already present, ${up.failed} failed` : 'n/a'} |`);
L.push(`| Test question | ${ret?.question ? `"${ret.question}"` : 'n/a'} |`);

const top = ret?.top_verified_source;
L.push(`| Retrieved document | ${top ? `${top.document} (v${top.version}, \`${top.document_id}\`)` : 'n/a'} |`);
L.push(`| Verified physical page | ${top ? `**${top.verified_page}**` : 'none verified'} |`);
L.push(`| Citation resolver result | ${top ? `\`${top.resolution}\`` : (ret ? 'all citations page-suppressed' : 'n/a')} |`);
L.push(`| Viewer URL | ${top ? `\`${top.viewer_url}\`` : 'n/a'} |`);
L.push(`| Retrieval duration | ${ret ? `${ret.duration_ms} ms (text-only path)` : 'n/a'} |`);
L.push('');

if (ret) {
  L.push('## Citations returned', '');
  L.push('| document_id | page | verified | resolution | lookup |', '|---|---|---|---|---|');
  for (const c of ret.all_citations || []) {
    if (c.rejected) L.push(`| REJECTED | — | no | ${c.reason} | — |`);
    else L.push(`| ${c.document_id} | ${c.page ?? '—'} | ${c.verified ? 'yes' : 'no'} | ${c.resolution} | ${c.lookup ?? '—'} |`);
  }
  L.push('', `Verified: ${ret.citations_verified} · page-suppressed: ${ret.citations_page_suppressed} · raw results: ${ret.retrieval_results}`, '');
}

L.push('## Warnings', '');
const warns = [];
for (const w of ing?.warnings ?? []) warns.push(`Ingestion — \`${w.code}\`: ${w.message}`);
for (const f of up?.failures ?? []) warns.push(`Upload — \`${f.unit_id}\`: ${f.error}`);
if (ret && ret.citations_page_suppressed > 0) warns.push(`Retrieval — ${ret.citations_page_suppressed} citation(s) had the page suppressed. Expected when the model paraphrases or an excerpt spans a page boundary; the document is still cited.`);
if (ret && (ret.all_citations || []).some(c => c.lookup === 'filename_fallback')) warns.push('Retrieval — one or more sources resolved by filename fallback rather than the `unit_id` attribute. Page verification is unaffected, but check that attributes were stored on the vector store files.');
if (!warns.length) warns.push('None recorded.');
L.push(...warns.map(w => `- ${w}`), '');

if (ing?.blocking_errors?.length) {
  L.push('## Blocking errors', '');
  L.push(...ing.blocking_errors.map(b => `- \`${b.code}\`: ${b.message}`), '');
}

L.push('---', '', ret?.citations_verified > 0 && up && !up.dry_run
  ? '**Chain is live: approved document → OpenAI retrieval → verified physical page.** Stage 2 is unblocked.'
  : '**Chain not yet proven end to end.** Do not begin Stage 2.');

console.log(L.join('\n'));
