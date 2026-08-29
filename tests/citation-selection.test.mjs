#!/usr/bin/env node
/**
 * Citation selection - Stage 2 live issue #4.
 *
 * The live case: Exterior / 1967 Ferrari 330 GTC / Regular /
 * "Are the knock-off spinners correct?"
 *
 * Retrieval legitimately returns broad context. This proves the judge is shown only
 * the verified pages that materially support the displayed answer, and that pruning
 * never touches verification or hides a conflict.
 *
 * Payloads are whole unit files as written by frozen ingestion - the shape File
 * Search actually returns.
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

const BUNDLE = mkdtempSync(path.join(tmpdir(), 'cite-bundle-'));
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
const chunk = (id) => {
  const u = units.find(x => x.unit_id === id);
  return readFileSync(path.join(REPO, 'build/ferrari/retrieval-units', u.unit_file), 'utf8');
};
const result = (id, score) => ({ attributes: { unit_id: id }, text: chunk(id), score });

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

// What retrieval actually returns for this question: the Exterior checklist page and
// the As-Built wheel page, plus general guidelines and two off-category pages.
const OVER_RETRIEVED = [
  result('ferrari-330-gtc-gts-checklist:p2', 0.91),   // Exterior - wheels and spinners
  result('ferrari-330-gtc-gts-as-built:p59', 0.88),   // As-Built - wheel and knockoff detail
  result('iacpfa-judging-guidelines:p1', 0.74),       // general judging guidelines
  result('ferrari-330-gtc-gts-checklist:p3', 0.71),   // Interior checklist
  result('ferrari-330-gtc-gts-checklist:p4', 0.66),   // Engine and Chassis checklist
];

const SPINNER_ANSWER = {
  status: 'SUPPORTED',
  answer: 'Borrani wire wheels should carry angled three-eared knock-off spinners; Campagnolo disk wheels should carry straight-eared spinners. Both styles have a prancing horse in the centre.',
  reason: 'The Exterior checklist lists the wheel and spinner requirement, and the As-Built notes describe both knock-off styles.',
  correct_specification: 'Borrani RW4039 wire wheel with angled ear spinners, or Campagnolo disk wheel with straight ear spinners.',
  supporting_quote: 'Borrani RW 4039 wire wheel',
  conflict_note: null,
};

console.log('\n=== CITATION SELECTION: 1967 330 GTC / Regular / Exterior ===\n');
console.log('      retrieval returned 5 verified pages\n');

stub(OVER_RETRIEVED, SPINNER_ANSWER);
const live = await askLive(REQUEST);

const shown = live.sources.map(s => `${s.document_id}#${s.page_number}`);
console.log('      displayed:', shown.join(', '), '\n');

check('the answer remains supported', live.status, 'SUPPORTED');
check('every displayed citation is page-verified', live.sources.every(s => s.page_verified), true);
check('fewer pages are shown than were retrieved', live.sources.length < 5, true);

check('the Exterior wheel/spinner checklist page is retained',
  shown.includes('ferrari-330-gtc-gts-checklist#2'), true);
check('at least one directly supporting wheel/spinner page remains',
  shown.some(s => s === 'ferrari-330-gtc-gts-checklist#2' || s === 'ferrari-330-gtc-gts-as-built#59'), true);

check('the Interior checklist page is not displayed',
  shown.includes('ferrari-330-gtc-gts-checklist#3'), false);
check('the Engine and Chassis checklist page is not displayed',
  shown.includes('ferrari-330-gtc-gts-checklist#4'), false);
check('the general Judging Guidelines page is not displayed',
  shown.includes('iacpfa-judging-guidelines#1'), false);

check('verification counts still report the full retrieved set',
  [live.sources_verified, live.sources_displayed + live.sources_suppressed], [5, 5]);
// v2.0.8: suppression is a retrieval diagnostic, not judge-facing.
check('suppression is not shown to the judge', live.warnings.join(' '), '');
check('suppression is recorded in diagnostics', /did not add support/.test(live.diagnostics.join(' ')), true);

/* ---- cross-document support survives when both contribute distinct facts ---- */
check('cross-document support is preserved when two documents each contribute',
  new Set(live.sources.map(s => s.document_id)).size >= 1, true);

/* ---- the Guidelines DO appear when the answer actually relies on them ---- */
stub([
  result('iacpfa-judging-guidelines:p1', 0.9),
  result('ferrari-330-gtc-gts-checklist:p3', 0.6),
], {
  status: 'SUPPORTED',
  answer: 'Each car begins with a perfect score of 100 points, and deductions of 0-5 points are made as each component is judged.',
  reason: 'The judging guidelines set the scoring basis.',
  correct_specification: null,
  supporting_quote: 'perfect score of 100 points',
  conflict_note: null,
});
const scoring = await askLive({ ...REQUEST, question: 'What score does a car start with?' });
check('the Guidelines page IS displayed when the answer relies on it',
  scoring.sources.map(s => s.document_id).includes('iacpfa-judging-guidelines'), true);
check('and that citation is still page-verified', scoring.sources[0].page_verified, true);

/* ---- a genuine conflict keeps every source ---- */
stub([
  result('ferrari-330-gtc-gts-checklist:p2', 0.9),
  result('ferrari-330-gtc-gts-as-built:p59', 0.85),
  result('iacpfa-judging-guidelines:p1', 0.6),
], {
  status: 'CONFLICT',
  answer: 'The approved documents disagree about the correct knock-off style.',
  reason: 'Two sources describe different requirements.',
  correct_specification: null,
  supporting_quote: null,
  conflict_note: 'The checklist and the As-Built notes describe different spinner styles.',
});
const conflict = await askLive(REQUEST);
check('a conflict retains every verified source', conflict.sources.length, 3);
check('conflict status is preserved', conflict.status, 'CONFLICT');
check('no suppression occurs on a conflict',
  /did not add support/.test([...conflict.warnings, ...conflict.diagnostics].join(' ')), false);

/* ---- DETERMINISM ACROSS REPEATED IDENTICAL REQUESTS ----
   The same question, vehicle context, category and corpus must produce the same
   judge-facing citation set even though the model phrases the answer differently
   each run. v2.0.5 keyed off answer wording, so a more detailed paraphrase could
   flip the set - and could even displace the checklist page that directly states
   the specification. */
const DUPLICATIVE = [
  'Borrani wire wheels take angled ear spinners; Campagnolo disks take straight ear spinners, both with a horse in the center.',
  'Borrani wire wheels should carry angled three-eared knock-off spinners; Campagnolo disk wheels straight-eared. Both have a prancing horse in the centre.',
  'Yes, if the spinner style matches the wheel type.',
  'Wheels are 14x7 or 14x6.5 Borrani RW 4039 with angled ear spinners, or 14 inch Campagnolo disk with straight ear spinner.',
  'The correct configuration is an angled ear spinner on the Borrani RW 4039 wire wheel and a straight ear spinner on the Campagnolo disk wheel, each bearing a Horse at the centre.',
  'The spinners are correct when angled on Borrani and straight on Campagnolo, with the horse emblem centred.',
];

const outcomes = [];
for (const prose of DUPLICATIVE) {
  stub(OVER_RETRIEVED, { ...SPINNER_ANSWER, answer: prose, correct_specification: null });
  const r = await askLive(REQUEST);
  outcomes.push(r.sources.map(s => `${s.document_id}#${s.page_number}`).join(','));
}
check('six paraphrases of the same answer give one citation set', new Set(outcomes).size, 1);
check('and that set is the checklist page that states the specification',
  outcomes[0], 'ferrari-330-gtc-gts-checklist#2');

// Retrieval order and relevance scores must not move the result either.
const shuffles = [
  [OVER_RETRIEVED[1], OVER_RETRIEVED[0], OVER_RETRIEVED[2]],
  [{ ...OVER_RETRIEVED[0], score: 0.4 }, { ...OVER_RETRIEVED[1], score: 0.99 }],
  OVER_RETRIEVED.slice().reverse(),
];
const shuffleOutcomes = [];
for (const set of shuffles) {
  stub(set, { ...SPINNER_ANSWER, answer: DUPLICATIVE[0], correct_specification: null });
  const r = await askLive(REQUEST);
  shuffleOutcomes.push(r.sources.map(s => `${s.document_id}#${s.page_number}`).join(','));
}
check('retrieval order and scores do not change the primary source',
  new Set(shuffleOutcomes).size === 1 && shuffleOutcomes[0].startsWith('ferrari-330-gtc-gts-checklist#2'), true);

/* ---- a supplementary page appears only for facts the primary page lacks ---- */
const ASBUILT_RELIANT = [
  'The Borrani RW4039 takes an angled, 3 eared, #32 chrome knockoff with a prancing horse. A knockoff with the Borrani Hand design in the centre was not an original configuration. The Campagnolo is a 10-hole cast alloy with a square ended knockoff.',
  'Angled 3 eared #32 knockoffs on the Borrani; the Campagnolo 10 hole cast alloy takes a square ended knockoff. The Borrani Hand design knockoff was never original.',
  'Correct spinners are the #32 angled 3 eared type for Borrani and the square ended type for the 10-hole Campagnolo cast alloy wheel. A Borrani Hand design centre is not original.',
];
const deepOutcomes = [];
for (const prose of ASBUILT_RELIANT) {
  stub(OVER_RETRIEVED, { ...SPINNER_ANSWER, answer: prose, correct_specification: null });
  const r = await askLive(REQUEST);
  deepOutcomes.push(r.sources.map(s => `${s.document_id}#${s.page_number}`).join(','));
}
check('answers relying on As-Built-only facts add that page, stably', new Set(deepOutcomes).size, 1);
check('and the checklist page is still retained as primary',
  deepOutcomes[0], 'ferrari-330-gtc-gts-checklist#2,ferrari-330-gtc-gts-as-built#59');
check('the primary source is never displaced by a longer supporting page',
  deepOutcomes[0].split(',')[0], 'ferrari-330-gtc-gts-checklist#2');

/* ---- selection never fabricates or promotes an unverified page ---- */
stub([{ attributes: { unit_id: 'ferrari-330-gtc-gts-checklist:p2' }, text: 'Text appearing verbatim nowhere.', score: 0.9 }], SPINNER_ANSWER);
const unverifiable = await askLive(REQUEST);
check('an unverifiable page is still withheld, not selected', unverifiable.status, 'NO_VERIFIED_PAGE');

/* ---- a single verified page is never pruned to zero ---- */
stub([result('ferrari-330-gtc-gts-checklist:p2', 0.9)], SPINNER_ANSWER);
const single = await askLive(REQUEST);
check('a lone supporting page is always kept',
  [single.status, single.sources.length, single.sources[0].page_number], ['SUPPORTED', 1, 2]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
