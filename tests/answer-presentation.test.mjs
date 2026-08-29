#!/usr/bin/env node
/**
 * Answer presentation - Stage 2 live issue #5.
 *
 * The live spinner answer said the same thing three times: the answer, the Correct
 * specification block, and the explanation below it. This proves the duplication is
 * removed deterministically, server-side, WITHOUT losing a source-supported fact.
 */

import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* import() takes a URL, not a filesystem path. A Windows absolute path starts with
   a drive letter, which Node reads as an unsupported 'c:' protocol. pathToFileURL
   produces the same file:/// URL these paths already resolved to on macOS and
   Linux, so behaviour there is unchanged. */
const moduleUrl = (rel) => pathToFileURL(path.join(REPO, rel)).href;

const BUNDLE = mkdtempSync(path.join(tmpdir(), 'pres-bundle-'));
mkdirSync(path.join(BUNDLE, 'build/ferrari'), { recursive: true });
mkdirSync(path.join(BUNDLE, 'config'), { recursive: true });
for (const f of readdirSync(path.join(REPO, 'build/ferrari')).filter(f => f.endsWith('.json')))
  copyFileSync(path.join(REPO, 'build/ferrari', f), path.join(BUNDLE, 'build/ferrari', f));
for (const f of readdirSync(path.join(REPO, 'config')).filter(f => f.endsWith('.json')))
  copyFileSync(path.join(REPO, 'config', f), path.join(BUNDLE, 'config', f));

process.env.LAMBDA_TASK_ROOT = BUNDLE;
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
const chunkOf = (id) => {
  const u = units.find(x => x.unit_id === id);
  return readFileSync(path.join(REPO, 'build/ferrari/retrieval-units', u.unit_file), 'utf8');
};
const result = (id, score) => ({ attributes: { unit_id: id }, text: chunkOf(id), score });

function stub(results, answer) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    output: [
      { type: 'file_search_call', results },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const { issueSession } = await import(moduleUrl('src/services/session.mjs'));
const cookie = issueSession().split(';')[0];
const { default: ask } = await import(moduleUrl('netlify/functions/ask.mjs'));
const askLive = async (body) => (await ask({
  method: 'POST', url: 'https://x/api/ask',
  headers: { get: (k) => (k === 'cookie' ? cookie : null) },
  json: async () => body,
})).json();

const REQUEST = {
  question: 'Are the knock-off spinners correct?',
  judging_category: 'Exterior',
  car: { year: '1967', model: '330 GTC', concours_class: 'Regular' },
};
const RETRIEVED = [result('ferrari-330-gtc-gts-checklist:p2', 0.91), result('ferrari-330-gtc-gts-as-built:p59', 0.83)];

console.log('\n=== ANSWER PRESENTATION ===\n');

/* ---- 1. The live case: three blocks saying the same thing ---- */
const REDUNDANT = {
  status: 'SUPPORTED',
  answer: 'Borrani wire wheels take angled ear spinners and Campagnolo disk wheels take straight ear spinners, both with a Horse in the centre. The Borrani wheel carries a Borrani hand decal on the hub opposite the valve stem.',
  correct_specification: 'Borrani wire wheel with angled ear spinners, or Campagnolo disk wheel with straight ear spinner. Both knock-off styles have a Horse in the centre of the spinner, and the Borrani wheel has a Borrani hand decal on the hub opposite the valve stem.',
  reason: 'The checklist specifies this wheel and spinner configuration along with the Horse and Borrani hand decal authenticity details.',
  supporting_quote: 'Borrani RW 4039 wire wheel',
  conflict_note: null,
};

stub(RETRIEVED, REDUNDANT);
const live = await askLive(REQUEST);

check('the answer is still supported', live.status, 'SUPPORTED');
check('the duplicated specification block is suppressed', live.correct_specification, null);
check('the duplicated explanation is suppressed', live.reason, null);
check('both suppressions are recorded server-side',
  live.presentation_suppressed.sort(), ['correct_specification', 'reason']);

// Nothing substantive may be lost: every distinctive term from the suppressed blocks
// must still be present in the answer the judge reads.
const { salience, salientSet, present } = await import(moduleUrl('src/services/text-salience.mjs'));
const sal = salience(units.map(u => u.primary_text));
// A "fact" is a distinctive term that actually appears in the cited source pages and
// is not merely borrowed from a document title - the same definition the suppressor
// uses. Prose glue ("specifies", "along", "details") is not a fact being lost.
const sourceBlob = [
  units.find(u => u.unit_id === 'ferrari-330-gtc-gts-checklist:p2').primary_text,
  units.find(u => u.unit_id === 'ferrari-330-gtc-gts-as-built:p59').primary_text,
].join('\n');
const titleBlob = '330 GTC/GTS Concours Judging Checklist 330 GTC/GTS As-Built Configuration, Authenticity, and Judging Notes IAC/PFA Judging Guidelines';
const factsLost = (block) => [...salientSet(block, sal)]
  .filter(t => !present(t, `${live.answer} ${REQUEST.question}`) && present(t, sourceBlob) && !present(t, titleBlob));
const lostFromSpec = factsLost(REDUNDANT.correct_specification);
const lostFromReason = factsLost(REDUNDANT.reason);
check('no distinctive fact from the specification block is lost', lostFromSpec, []);
check('no distinctive fact from the explanation is lost', lostFromReason, []);

check('the judge reads materially less text',
  live.answer.length < (REDUNDANT.answer + REDUNDANT.correct_specification + REDUNDANT.reason).length / 2, true);
check('the answer stays within a few short sentences',
  live.answer.split(/(?<=[.!?])\s+/).filter(Boolean).length <= 3, true);

/* ---- 2. Citation behaviour is untouched ---- */
check('verified checklist page 2 still displays',
  [live.sources[0].document_id, live.sources[0].page_number, live.sources[0].page_verified],
  ['ferrari-330-gtc-gts-checklist', 2, true]);
check('source opening is unchanged',
  live.sources[0].viewer_url, '/source/ferrari-330-gtc-gts-checklist/page/2');
check('the judging responsibility note is retained', /judge determines the actual deduction/.test(live.judge_note), true);

/* ---- 3. A specification that genuinely adds detail is kept ---- */
stub(RETRIEVED, {
  status: 'SUPPORTED',
  answer: 'The knock-off spinners are correct: angled ears on the Borrani, straight ears on the Campagnolo.',
  correct_specification: 'Borrani RW 4039 wire wheel, 14x7 or 14x6.5, with a 3 eared #32 chrome knockoff; Campagnolo 10-hole cast alloy disk wheel, 14 inch, square ended.',
  reason: null,
  supporting_quote: null,
  conflict_note: null,
});
const distinct = await askLive(REQUEST);
check('a specification carrying distinct detail is retained', distinct.correct_specification !== null, true);
check('and nothing is reported as suppressed', distinct.presentation_suppressed, []);

/* ---- 4. A reason carrying a genuine caveat survives ---- */
stub(RETRIEVED, {
  status: 'SUPPORTED',
  answer: 'Borrani wire wheels take angled ear spinners; Campagnolo disks take straight ear spinners.',
  correct_specification: null,
  reason: 'Some early cars have been seen with build sheets showing 14 x 6.5 wire wheels.',
  supporting_quote: null,
  conflict_note: null,
});
const caveat = await askLive(REQUEST);
check('an explanation adding a genuine caveat is kept', caveat.reason !== null, true);

/* ---- 5. Other states are unaffected ---- */
stub([{ attributes: { unit_id: 'ferrari-330-gtc-gts-checklist:p2' }, text: 'Text appearing verbatim nowhere.', score: 0.9 }], REDUNDANT);
const withheld = await askLive(REQUEST);
check('withheld-answer behaviour is unchanged',
  [withheld.status, withheld.correct_specification, withheld.reason], ['NO_VERIFIED_PAGE', null, null]);

stub(RETRIEVED, {
  status: 'CONFLICT',
  answer: 'The approved documents disagree about the correct knock-off style.',
  correct_specification: null,
  reason: 'Two sources describe different requirements.',
  supporting_quote: null,
  conflict_note: 'The checklist and the As-Built notes describe different spinner styles.',
});
const conflict = await askLive(REQUEST);
check('conflict status and its note are unchanged',
  [conflict.status, conflict.conflict_note !== null, conflict.sources.length], ['CONFLICT', true, 2]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
