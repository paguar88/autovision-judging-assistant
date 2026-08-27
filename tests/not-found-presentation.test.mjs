#!/usr/bin/env node
/**
 * Supported vs not-found presentation - Stage 2 v2.0.12.
 *
 * "I found pages" is not "I found the answer". A page becomes a supporting citation
 * only when it carries evidence for the displayed answer. Retrieval proximity and page
 * verification are necessary, not sufficient.
 *
 * Positive case: the spinner question must be unchanged.
 * Negative case: the steering-wheel question must not be dressed as supported.
 */

import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const BUNDLE = mkdtempSync(path.join(tmpdir(), 'nf-bundle-'));
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

const { issueSession } = await import(`${REPO}/src/services/session.mjs`);
const cookie = issueSession().split(';')[0];
const { default: ask } = await import(`${REPO}/netlify/functions/ask.mjs`);
const askLive = async (body) => (await ask({
  method: 'POST', url: 'https://x/api/ask',
  headers: { get: (k) => (k === 'cookie' ? cookie : null) },
  json: async () => body,
})).json();

const CAR = { year: '1967', model: '330 GTC', concours_class: 'Regular' };

console.log('\n=== SUPPORTED vs NOT FOUND ===\n');

/* ---------- POSITIVE CASE: unchanged ---------- */
stub([
  result('ferrari-330-gtc-gts-checklist:p2', 0.91),
  result('ferrari-330-gtc-gts-as-built:p59', 0.83),
  result('iacpfa-judging-guidelines:p1', 0.70),
], {
  status: 'SUPPORTED',
  answer: 'Borrani wire wheels take angled ear spinners and Campagnolo disk wheels take straight ear spinners, both with a Horse in the centre.',
  correct_specification: null,
  reason: null,
  supporting_quote: 'Borrani RW 4039 wire wheel',
  conflict_note: null,
});
const spinner = await askLive({ question: 'Are the knock-off spinners correct?', judging_category: 'Exterior', car: CAR });

check('spinner question is supported', spinner.status, 'SUPPORTED');
check('the heading reads Official source found', spinner.confidence_label, 'Official source found');
check('checklist page 2 is the supporting evidence',
  [spinner.sources[0].document_id, spinner.sources[0].page_number, spinner.sources[0].page_verified],
  ['ferrari-330-gtc-gts-checklist', 2, true]);
check('View Source opens the verified page',
  spinner.sources[0].viewer_url, '/source/ferrari-330-gtc-gts-checklist/page/2');
check('a supported answer has no reviewed-sources section', spinner.sources_reviewed, []);

/* ---------- NEGATIVE CASE: the steering wheel ---------- */
// Five pages retrieved and page-verified, none stating a steering-wheel specification,
// and the model self-reports SUPPORTED while writing an honest not-found sentence.
const REVIEWED_FIVE = [
  result('ferrari-330-gtc-gts-checklist:p3', 0.78),
  result('ferrari-330-gtc-gts-as-built:p33', 0.74),
  result('ferrari-330-gtc-gts-checklist:p2', 0.70),
  result('ferrari-330-gtc-gts-as-built:p59', 0.66),
  result('iacpfa-judging-guidelines:p1', 0.61),
];
const NOT_FOUND_PROSE = 'The documents reviewed do not specify the correct steering wheel type, material, or appearance for a 1967 Ferrari 330 GTC.';

stub(REVIEWED_FIVE, {
  status: 'SUPPORTED',                       // the model got this wrong
  answer: NOT_FOUND_PROSE,
  correct_specification: 'A period-correct steering wheel.',
  reason: 'The checklist and As-Built notes were reviewed.',
  supporting_quote: null,
  conflict_note: null,
});
const wheel = await askLive({
  question: 'What is the correct steering wheel for a 1967 Ferrari 330 GTC?',
  judging_category: 'Interior', car: CAR,
});

check('a not-found answer is not presented as supported', wheel.status, 'NOT_FOUND');
check('the heading reads Not found in approved documents',
  wheel.confidence_label, 'Not found in approved documents');
check('Official source found is absent', wheel.confidence_label === 'Official source found', false);
check('the honest answer text is preserved', wheel.answer, NOT_FOUND_PROSE);
check('no specification is invented', wheel.correct_specification, null);
check('no supporting explanation is carried over', wheel.reason, null);

check('retrieved pages are not affirmative citations', wheel.sources, []);
check('at most two reviewed sources are shown', wheel.sources_reviewed.length <= 2, true);
check('exactly the two most relevant are shown', wheel.sources_reviewed.length, 2);
check('reviewed sources keep their verified page',
  wheel.sources_reviewed.map(s => `${s.document_id}#${s.page_number}`),
  ['ferrari-330-gtc-gts-checklist#3', 'ferrari-330-gtc-gts-as-built#33']);
check('reviewed sources can still be opened',
  wheel.sources_reviewed.every(s => s.page_verified && s.viewer_url.includes('/page/')), true);
check('the full reviewed count is retained internally', wheel.sources_verified, 5);
check('the diagnostics record the conversion',
  wheel.diagnostics.some(d => /Presented as NOT_FOUND/.test(d)), true);
check('the diagnostics record how many pages were reviewed',
  wheel.diagnostics.some(d => /5 page\(s\) were reviewed/.test(d)), true);
check('no diagnostics reach the judge', wheel.warnings, []);

/* ---------- verification alone must not promote a page ---------- */
const { statesNotFound } = await import(`${REPO}/src/services/answer-policy.mjs`);
check('page verification alone does not create supporting evidence',
  wheel.sources_reviewed.every(s => s.page_verified) && wheel.sources.length === 0, true);

check('a not-found opening clause is detected', statesNotFound(NOT_FOUND_PROSE), true);
for (const phrase of [
  'The approved documents do not state the correct finish for this component.',
  'No specification for this component appears in the approved documents.',
  'The correct pattern is not specified in the approved documents.',
  'I could not find a supported answer in the approved source documents.',
]) check(`detected: "${phrase.slice(0, 42)}…"`, statesNotFound(phrase), true);

// A supported answer carrying a later caveat must not be reclassified.
for (const phrase of [
  'Borrani wire wheels take angled ear spinners. The documents do not state a maximum deduction.',
  'Seats have 9 pleats with cream trim over the windows and headliner.',
  'The valve cover is all black crinkle paint including the Ferrari name.',
]) check(`not misread: "${phrase.slice(0, 42)}…"`, statesNotFound(phrase), false);

/* ---------- an explicit NO_SOURCE also avoids affirmative cards ---------- */
stub(REVIEWED_FIVE, {
  status: 'NO_SOURCE', answer: null, correct_specification: null, reason: null,
  supporting_quote: null, conflict_note: null,
});
const noSource = await askLive({ question: 'What is the correct wiring loom tape?', judging_category: 'Interior', car: CAR });
check('NO_SOURCE shows no affirmative citations', noSource.sources, []);
check('NO_SOURCE shows at most two reviewed sources', noSource.sources_reviewed.length, 2);


/* ---------- v2.0.13: the LIVE steering-wheel case ----------
   The model reported INSUFFICIENT_INFO, which the v2.0.12 gate never considered for
   override, so the negative answer kept a context-missing heading and all five pages
   rendered as ordinary citations. */
const LIVE_PROSE = 'The provided sources do not contain specific information about the correct steering wheel for the 1967 Ferrari 330 GTC, such as brand, material, color, design, or distinguishing features.';
stub(REVIEWED_FIVE, {
  status: 'INSUFFICIENT_INFO',
  answer: LIVE_PROSE,
  correct_specification: null, reason: null, supporting_quote: null, conflict_note: null,
});
const liveWheel = await askLive({
  question: 'What is the correct steering wheel for a 1967 Ferrari 330 GTC?',
  judging_category: 'Interior', car: CAR,
});
check('INSUFFICIENT_INFO with corpus-negative prose becomes NOT_FOUND', liveWheel.status, 'NOT_FOUND');
check('the heading is Not found in approved documents',
  liveWheel.confidence_label, 'Not found in approved documents');
check('the honest sentence is preserved', liveWheel.answer, LIVE_PROSE);
check('no steering-wheel specification is invented', liveWheel.correct_specification, null);
check('none of the five pages become affirmative citations', liveWheel.sources, []);
check('at most two reviewed sources are offered', liveWheel.sources_reviewed.length, 2);
check('reviewed sources remain openable',
  liveWheel.sources_reviewed.every(s => s.page_verified && s.viewer_url.includes('/page/')), true);
check('all five stay in diagnostics', liveWheel.sources_verified, 5);

/* ---------- paraphrase variants all reach the same state ---------- */
for (const [label, prose] of [
  ['documents reviewed do not specify', 'The documents reviewed do not specify the correct steering wheel type.'],
  ['sources do not contain', 'The provided sources do not contain specific information about this component.'],
  ['documents do not provide', 'The approved documents do not provide a specification for the steering wheel.'],
  ['no information was found', 'No information about the steering wheel was found in the approved documents.'],
  ['corpus does not state', 'The corpus does not state the correct steering wheel finish.'],
  ['documents are silent', 'The approved documents are silent on the steering wheel.'],
  ['contraction', "The checklist doesn't mention the steering wheel."],
]) {
  stub(REVIEWED_FIVE, {
    status: 'INSUFFICIENT_INFO', answer: prose,
    correct_specification: null, reason: null, supporting_quote: null, conflict_note: null,
  });
  const r = await askLive({ question: 'What is the correct steering wheel?', judging_category: 'Interior', car: CAR });
  check(`variant reaches NOT_FOUND: ${label}`, [r.status, r.sources.length], ['NOT_FOUND', 0]);
}

/* ---------- a genuine INSUFFICIENT_INFO stays distinct ---------- */
stub(REVIEWED_FIVE, {
  status: 'INSUFFICIENT_INFO',
  answer: 'The question does not identify which component of the interior is being judged.',
  correct_specification: null, reason: null, supporting_quote: null, conflict_note: null,
});
// Must name a subject, or the standalone-question guard (A.12) stops it earlier -
// which is itself correct, but a different mechanism from the one under test here.
const vague = await askLive({ question: 'What is the correct finish for the trim?', judging_category: 'Interior', car: CAR });
check('missing judge context stays INSUFFICIENT_INFO', vague.status, 'INSUFFICIENT_INFO');
check('it is not relabelled as a corpus gap',
  vague.confidence_label, 'Insufficient information');
check('it shows no affirmative citations', vague.sources, []);
check('and does not imply the corpus lacks the answer', vague.sources_reviewed, []);

/* ---------- the two states are never interchangeable ---------- */
check('corpus-negative prose is classified as such',
  statesNotFound('The approved documents do not contain this specification.'), true);
check('context-missing prose is not',
  statesNotFound('The question does not identify which component is being judged.'), false);
check('a missing-year statement is not corpus-negative',
  statesNotFound('The year is required before this can be answered.'), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
