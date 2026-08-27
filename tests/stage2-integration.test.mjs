#!/usr/bin/env node
/**
 * Stage 2 integration - live issue #2.
 *
 * Exercises the REAL ask.mjs handler inside a faithful simulation of the deployed
 * `ask` function bundle: only the files netlify.toml includes for it, and therefore
 * NO page-slice bytes. That absence is what suppressed every verified page in
 * production while the same corpus verified cleanly in Stage 1's GitHub runner.
 *
 * The retrieval payload is the whole unit file as written by frozen ingestion -
 * the exact shape OpenAI File Search returns - not a hand-picked excerpt.
 */

import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/* Build the ask-function bundle: build/ferrari/*.json + config/*.json, nothing else. */
const BUNDLE = mkdtempSync(path.join(tmpdir(), 'ask-bundle-'));
mkdirSync(path.join(BUNDLE, 'build/ferrari'), { recursive: true });
mkdirSync(path.join(BUNDLE, 'config'), { recursive: true });
for (const f of readdirSync(path.join(REPO, 'build/ferrari')).filter(f => f.endsWith('.json')))
  copyFileSync(path.join(REPO, 'build/ferrari', f), path.join(BUNDLE, 'build/ferrari', f));
for (const f of readdirSync(path.join(REPO, 'config')).filter(f => f.endsWith('.json')))
  copyFileSync(path.join(REPO, 'config', f), path.join(BUNDLE, 'config', f));

process.env.LAMBDA_TASK_ROOT = BUNDLE;           // must precede any corpus import
process.env.BETA_PASSWORD = 'test-password';
process.env.OPENAI_API_KEY = 'stub';
process.env.OPENAI_VECTOR_STORE_ID_FERRARI = 'vs_stub';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
};

const units = JSON.parse(readFileSync(path.join(REPO, 'build/ferrari/retrieval-units.json'), 'utf8')).units;
const unitFile = (id) => {
  const u = units.find(x => x.unit_id === id);
  return readFileSync(path.join(REPO, 'build/ferrari/retrieval-units', u.unit_file), 'utf8');
};

/** Stub only the network. Everything else is the real code path. */
function stubOpenAI(results, answer) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    output: [
      { type: 'file_search_call', results },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const SUPPORTED_ANSWER = {
  status: 'SUPPORTED',
  answer: 'Borrani wire wheels take angled three-eared spinners; Campagnolo disc wheels take straight three-eared spinners.',
  reason: 'Both the checklist and the As-Built notes describe the correct knock-off styles.',
  correct_specification: 'Both styles carry a prancing horse in the centre of the spinner.',
  supporting_quote: 'chrome knockoff with a prancing',
  conflict_note: null,
};

const { issueSession } = await import(`${REPO}/src/services/session.mjs`);
const cookie = issueSession().split(';')[0];
const { default: ask } = await import(`${REPO}/netlify/functions/ask.mjs`);

const askLive = async (body) => {
  const res = await ask({
    method: 'POST', url: 'https://x/api/ask',
    headers: { get: (k) => (k === 'cookie' ? cookie : null) },
    json: async () => body,
  });
  return res.json();
};

// The exact live case: 1967 Ferrari 330 GTC / Regular / Exterior.
const REQUEST = {
  question: 'Are the knock-off spinners correct?',
  judging_category: 'Exterior',
  car: { year: '1967', model: '330 GTC', concours_class: 'Regular' },
};

console.log('\n=== STAGE 2 INTEGRATION: verified page through the real ask path ===\n');
console.log(`      ask-function bundle: ${readdirSync(path.join(BUNDLE, 'build/ferrari')).length} json files, 0 page slices\n`);

/* ---- 1. The live case must produce verified physical pages ---- */
stubOpenAI([
  { attributes: { unit_id: 'ferrari-330-gtc-gts-checklist:p3' }, text: unitFile('ferrari-330-gtc-gts-checklist:p3'), score: 0.92 },
  { attributes: { unit_id: 'ferrari-330-gtc-gts-as-built:p59' }, text: unitFile('ferrari-330-gtc-gts-as-built:p59'), score: 0.81 },
], SUPPORTED_ANSWER);

const live = await askLive(REQUEST);

check('status is SUPPORTED', live.status, 'SUPPORTED');
check('every returned source is page-verified',
  live.sources.map(s => s.page_verified), [true, true]);
check('checklist resolves to physical page 3 (Stage 1 baseline)',
  [live.sources[0].document_id, live.sources[0].page_number, live.sources[0].resolution],
  ['ferrari-330-gtc-gts-checklist', 3, 'RESOLVED_PRIMARY']);
check('As-Built resolves to physical page 59 (Stage 1 baseline)',
  [live.sources[1].document_id, live.sources[1].page_number], ['ferrari-330-gtc-gts-as-built', 59]);
check('View Exact Source receives the verified page route',
  live.sources[0].viewer_url, '/source/ferrari-330-gtc-gts-checklist/page/3');
check('no "page could not be verified" warning is raised', live.warnings, []);
check('no deduction is stated (A.1)', live.deduction.applicable, false);
check('no score-sheet line or maximum (A.10)',
  [live.deduction.score_sheet_line, live.deduction.maximum_deduction], [null, null]);

/* ---- 2. Fail safe when verification genuinely cannot succeed ---- */
// Text that appears verbatim on no page: the resolver must suppress, and the policy
// must withhold the answer rather than present it under "Page not verified".
stubOpenAI([
  { attributes: { unit_id: 'ferrari-330-gtc-gts-checklist:p3' }, text: 'Paraphrased material that appears verbatim nowhere in the approved corpus.', score: 0.9 },
], SUPPORTED_ANSWER);

const unverified = await askLive(REQUEST);
check('unverifiable page withholds the answer', unverified.status, 'NO_VERIFIED_PAGE');
check('no authoritative answer text is shown', unverified.answer.includes('not shown without a verified source page'), true);
check('the model\'s conclusion is discarded, not caveated',
  [unverified.reason, unverified.correct_specification], [null, null]);
check('the document is still listed for the judge', unverified.sources.length, 1);
check('but with no page and a document-level route',
  [unverified.sources[0].page_number, unverified.sources[0].viewer_url],
  [null, '/source/ferrari-330-gtc-gts-checklist']);

/* ---- 3. A source outside the approved manifest is still rejected ---- */
stubOpenAI([{ attributes: { unit_id: 'forged:p1' }, text: 'anything', score: 0.99 }], SUPPORTED_ANSWER);
const forged = await askLive(REQUEST);
check('forged unit id yields no source and no answer', [forged.sources.length, forged.status], [0, 'NO_SOURCE']);

/* ---- 4. View Exact Source actually opens that page ----
   Runs with the `source` function's bundle root, which DOES include the slice bytes
   per netlify.toml - deliberately a different root from the ask bundle above. */
const viewer = execFileSync(process.execPath, ['-e', `
  process.env.BETA_PASSWORD='test-password';
  (async()=>{
    const {issueSession}=await import('${REPO}/src/services/session.mjs');
    const {default:source}=await import('${REPO}/netlify/functions/source.mjs');
    const c=issueSession().split(';')[0];
    const res=await source({method:'GET',url:'https://x/s?document_id=ferrari-330-gtc-gts-checklist&page=3',
      headers:{get:k=>k==='cookie'?c:null}});
    const buf=Buffer.from(await res.arrayBuffer());
    console.log(JSON.stringify({status:res.status,type:res.headers.get('content-type'),
      page:res.headers.get('x-source-page'),pdf:buf.subarray(0,4).toString()==='%PDF',bytes:buf.length}));
  })();
`], { encoding: 'utf8', cwd: REPO, env: { ...process.env, LAMBDA_TASK_ROOT: REPO } }).trim();
const v = JSON.parse(viewer);
check('View Exact Source returns the verified page as a PDF',
  [v.status, v.type, v.page, v.pdf], [200, 'application/pdf', '3', true]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
