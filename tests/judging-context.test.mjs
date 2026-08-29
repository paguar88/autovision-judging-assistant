#!/usr/bin/env node
/**
 * Judging context and judge-facing output - Stage 2 v2.0.8.
 *
 * Two things are proven here:
 *  1. A question cannot be asked before year, model, judging area and class are
 *     established - enforced on the REQUEST PATH, not only by a disabled control.
 *  2. Retrieval diagnostics no longer reach the judge, while citation selection and
 *     suppression keep running in full.
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

const BUNDLE = mkdtempSync(path.join(tmpdir(), 'ctx-bundle-'));
mkdirSync(path.join(BUNDLE, 'build/ferrari'), { recursive: true });
mkdirSync(path.join(BUNDLE, 'build/ferrari-test'), { recursive: true });
mkdirSync(path.join(BUNDLE, 'config'), { recursive: true });
for (const f of readdirSync(path.join(REPO, 'build/ferrari')).filter(f => f.endsWith('.json')))
  copyFileSync(path.join(REPO, 'build/ferrari', f), path.join(BUNDLE, 'build/ferrari', f));
// The ferrari-test brand reads config/model-aliases-test.json, the only alias
// table carrying model_coverage. corpus() loads a brand's manifest eagerly, so
// its build artifacts have to be present for resolveModel to reach that table.
for (const f of readdirSync(path.join(REPO, 'build/ferrari-test')).filter(f => f.endsWith('.json')))
  copyFileSync(path.join(REPO, 'build/ferrari-test', f), path.join(BUNDLE, 'build/ferrari-test', f));
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

const html = readFileSync(path.join(REPO, 'public/index.html'), 'utf8');
const appjs = readFileSync(path.join(REPO, 'public/app.js'), 'utf8');
const css = readFileSync(path.join(REPO, 'public/styles.css'), 'utf8');

const units = JSON.parse(readFileSync(path.join(REPO, 'build/ferrari/retrieval-units.json'), 'utf8')).units;
const chunkOf = (id) => {
  const u = units.find(x => x.unit_id === id);
  return readFileSync(path.join(REPO, 'build/ferrari/retrieval-units', u.unit_file), 'utf8');
};
const result = (id, score) => ({ attributes: { unit_id: id }, text: chunkOf(id), score });

let openAICalls = 0;
let lastOpenAIRequest = null;
function stub(results, answer) {
  globalThis.fetch = async (url, init) => {
    openAICalls++;
    lastOpenAIRequest = init && init.body ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({
      output: [
        { type: 'file_search_call', results },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const { issueSession } = await import(moduleUrl('src/services/session.mjs'));
const cookie = issueSession().split(';')[0];
const { default: ask } = await import(moduleUrl('netlify/functions/ask.mjs'));
const askLive = async (body) => {
  const res = await ask({
    method: 'POST', url: 'https://x/api/ask',
    headers: { get: (k) => (k === 'cookie' ? cookie : null) },
    json: async () => body,
  });
  return { status: res.status, body: await res.json() };
};

const FULL = {
  question: 'Are the knock-off spinners correct?',
  judging_category: 'Exterior',
  car: { year: '1967', model: '330 GTC', concours_class: 'Regular' },
};
const RETRIEVED = [
  result('ferrari-330-gtc-gts-checklist:p2', 0.91),
  result('ferrari-330-gtc-gts-as-built:p59', 0.83),
  result('iacpfa-judging-guidelines:p1', 0.70),
  result('ferrari-330-gtc-gts-checklist:p3', 0.66),
  result('ferrari-330-gtc-gts-checklist:p4', 0.61),
];
const ANSWER = {
  status: 'SUPPORTED',
  answer: 'Borrani wire wheels take angled ear spinners and Campagnolo disk wheels take straight ear spinners, both with a Horse in the centre.',
  correct_specification: null,
  reason: null,
  supporting_quote: 'Borrani RW 4039 wire wheel',
  conflict_note: null,
};

console.log('\n=== JUDGING CONTEXT AND JUDGE-FACING OUTPUT ===\n');

/* ---- 1. The request path rejects incomplete context ---- */
stub(RETRIEVED, ANSWER);
const incomplete = [
  ['no context at all', { question: FULL.question }],
  ['missing year', { ...FULL, car: { ...FULL.car, year: null } }],
  ['missing model', { ...FULL, car: { ...FULL.car, model: null } }],
  ['missing judging area', { ...FULL, judging_category: null }],
  ['missing class', { ...FULL, car: { ...FULL.car, concours_class: null } }],
  ['two-digit year', { ...FULL, car: { ...FULL.car, year: '67' } }],
];
for (const [label, body] of incomplete) {
  const r = await askLive(body);
  check(`rejected: ${label}`, [r.status, r.body.status], [400, 'CONTEXT_INCOMPLETE']);
}
check('an incomplete request names what is missing',
  (await askLive({ ...FULL, judging_category: null })).body.missing, ['judging area']);

const before = openAICalls;
await askLive({ question: FULL.question });
check('no OpenAI request is made for an incomplete context', openAICalls, before);

/* ---- 2. A complete context is accepted and behaves as before ---- */
const ok = await askLive(FULL);
check('a complete context is accepted', [ok.status, ok.body.status], [200, 'SUPPORTED']);
check('the spinner case still cites checklist page 2',
  [ok.body.sources[0].document_id, ok.body.sources[0].page_number, ok.body.sources[0].page_verified],
  ['ferrari-330-gtc-gts-checklist', 2, true]);
check('View Exact Source route is unchanged',
  ok.body.sources[0].viewer_url, '/source/ferrari-330-gtc-gts-checklist/page/2');

/* ---- 3. Diagnostics are no longer shown to the judge ---- */
check('no retrieval diagnostics reach the judge', ok.body.warnings, []);
check('but suppression still happened internally', ok.body.sources_suppressed > 0, true);
check('and the count is retained in the payload',
  ok.body.sources_displayed + ok.body.sources_suppressed, ok.body.sources_verified);
check('the diagnostic text moved to the diagnostics field',
  ok.body.diagnostics.some(d => /did not add support/.test(d)), true);
check('the judge-facing interface renders only warnings',
  /\(a\.warnings \|\| \[\]\)\.forEach/.test(appjs) && !/diagnostics/.test(appjs.split('renderAnswer')[1] || ''), true);

/* ---- 4. Judge-relevant notices are still shown ---- */
const alias = await askLive({ ...FULL, car: { year: '1990', model: 'Daytona', concours_class: 'Regular' } });
check('alias normalisation is still surfaced to the judge',
  alias.body.warnings.some(w => /Daytona/.test(w)), true);
check('a year outside the configured range is still surfaced',
  alias.body.warnings.some(w => /outside the approved year range/.test(w)), true);

/* ---- 5. Interface structure ---- */
check('the header carries the marque in uppercase', /wordmark__marque">FERRARI</.test(html), true);
check('Source Documents remains in the header', /id="openSources"/.test(html), true);
check('the question field ships disabled', /id="question"[^>]*disabled/.test(html), true);
check('the Ask button ships disabled', /id="ask"[^>]*disabled/.test(html), true);
check('the setup panel is titled Judging Information', /setup__title">Judging Information</.test(html), true);
check('Clear and Set sit in the panel header, Clear first',
  html.indexOf('id="clearInfo"') < html.indexOf('id="setContext"')
  && /setup__actions[\s\S]{0,240}id="setContext"/.test(html), true);
check('Set carries the primary emphasis, Clear does not',
  [/id="clearInfo"[^>]*btn--ghost/.test(html), /id="setContext"[^>]*btn--primary/.test(html)], [true, true]);
check('both setup controls are compact, not full-width bars',
  /id="clearInfo"[^>]*btn--sm/.test(html) && /id="setContext"[^>]*btn--sm/.test(html), true);
check('the submit control reads SUBMIT QUESTION', />SUBMIT QUESTION</.test(html), true);
check('the disabled question placeholder is short',
  /placeholder="Set judging information first"/.test(html), true);
check('year and model share a row', /class="row row--car"/.test(html) && /\.row--car \{ display: grid/.test(css), true);
check('year is the narrow field', /grid-template-columns: 5\.5rem 1fr/.test(css), true);
check('all four context controls exist',
  ['carYear', 'carModel', 'data-category', 'data-class'].every(k => html.includes(k)), true);
check('the context header exposes a Change control', /id="changeContext"/.test(html), true);
check('no external fonts are loaded', /fonts\.googleapis|@import|@font-face/.test(html + css), false);
for (const gone of ['SET CAR &amp; BEGIN JUDGING', 'Clear car details', 'All four are required', 'Set the judging context']) {
  check(`obsolete copy removed: "${gone}"`, html.includes(gone), false);
}
check('the locked suffix is gone from the question label', css.includes('· locked'), false);

/* ---- 6. Client state rules ---- */
const ctxFn = appjs.match(/function contextComplete\([\s\S]*?\n}/)[0];
const contextComplete = new Function(`${ctxFn}; return contextComplete;`)();
const ctx = (year, model, cls, cat) => ({ car: { year, model, concours_class: cls }, category: cat });
check('client agrees a full context is complete', contextComplete(ctx('1967', '330 GTC', 'Regular', 'Exterior')), true);
for (const [label, c] of [
  ['no year', ctx(null, '330 GTC', 'Regular', 'Exterior')],
  ['no model', ctx('1967', null, 'Regular', 'Exterior')],
  ['no class', ctx('1967', '330 GTC', null, 'Exterior')],
  ['no area', ctx('1967', '330 GTC', 'Regular', null)],
  ['short year', ctx('67', '330 GTC', 'Regular', 'Exterior')],
]) check(`client blocks: ${label}`, contextComplete(c), false);

check('Ask is refused client-side before establishment', /if \(!state\.established\) return;/.test(appjs), true);
check('establishing focuses the question field', /\$\('question'\)\.focus\(\)/.test(appjs), true);
check('establishing collapses the setup panel', /show\(\$\('setup'\), false\)/.test(appjs), true);
check('Ask becomes the primary action once established',
  /on \? 'btn btn--primary' : 'btn btn--ghost'/.test(appjs), true);
check('Change reopens setup with current values populated',
  /state\.draft = \{ category: state\.category, concours_class: state\.car\.concours_class \}/.test(appjs), true);
check('changing context clears the displayed answer',
  /function openSetup\(\)[\s\S]*?clearAnswer\(\)/.test(appjs), true);
check('the redundant Last question line is gone',
  /lastQuestion|Last question/.test(appjs + html + css), false);
check('Clear resets the judging information fields',
  /\$\('clearInfo'\)\.addEventListener/.test(appjs), true);
// Clear only resets the draft; it must not silently establish or unestablish anything.
const clearBody = appjs.match(/\$\('clearInfo'\)\.addEventListener\([\s\S]*?\n}\);/)[0];
check('Clear does not change the established state', /state\.established/.test(clearBody), false);
// Inspect the function body itself rather than guessing by proximity.
const openSetupBody = appjs.match(/function openSetup\(\)[\s\S]*?\n}/)[0];
check('Change is wired to reopen the setup panel',
  /\$\('changeContext'\)\.addEventListener\('click', openSetup\)/.test(appjs), true);
check('reopening the context never clears year or model',
  /carYear|carModel|state\.car =/.test(openSetupBody), false);
check('reopening the context does clear the answer',
  /clearAnswer\(\)/.test(openSetupBody), true);


/* ---- 7. Session-only question history never reaches OpenAI ---- */
// Re-issue the spinner request so the captured payload is the one under test.
await askLive(FULL);
const sent = JSON.stringify(lastOpenAIRequest);
check('the OpenAI request carries the current question', /knock-off spinners/.test(sent), true);
check('it carries the structured judging context',
  ['1967', '330 GTC', 'Regular', 'Exterior'].every(v => sent.includes(v)), true);
check('it carries no history, thread or prior-turn field',
  /history|previous|prior|conversation|messages"\s*:/.test(sent), false);
check('only one user turn is sent', lastOpenAIRequest.input.length, 1);

// The client payload the browser builds must contain no history either.
const askBody = appjs.match(/const payload = \{[\s\S]*?\};/)[0];
check('the client request payload is question plus context only',
  /const payload = \{ question, judging_category: state\.category, car: state\.car \};/.test(askBody), true);
check('history is not referenced anywhere in the request payload',
  /history/.test(askBody), false);

/* ---- history lifecycle, executing the shipped functions ---- */
const src = (name) => appjs.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))[0];
const H = new Function(`${src('carIdentity')}; ${src('readHistory')}; ${src('writeHistory')};
  const HISTORY_KEY='cja:question-history';
  return { carIdentity, readHistory, writeHistory };`)();

const fakeStore = (() => { let v = {}; return { getItem: k => v[k] ?? null, setItem: (k, s) => { v[k] = s; } }; })();
const car = { year: '1967', model: '330 GTC', concours_class: 'Regular' };
H.writeHistory(H.carIdentity(car), [{ question: 'Are the knock-off spinners correct?', category: 'Exterior' }], fakeStore);

check('history is keyed on year and model only',
  H.carIdentity(car), H.carIdentity({ year: '1967', model: '330 GTC', concours_class: 'Preservation' }));
check('changing judging area keeps the history',
  H.readHistory(H.carIdentity(car), fakeStore).length, 1);
check('changing class keeps the history',
  H.readHistory(H.carIdentity({ ...car, concours_class: 'Preservation' }), fakeStore).length, 1);
check('model case does not fragment the history',
  H.readHistory(H.carIdentity({ ...car, model: '330 gtc' }), fakeStore).length, 1);
check('a different car has no history',
  H.readHistory(H.carIdentity({ year: '1972', model: '365 GTB/4' }), fakeStore).length, 0);
check('a different year has no history',
  H.readHistory(H.carIdentity({ ...car, year: '1968' }), fakeStore).length, 0);
check('Clear wipes the stored history', (() => {
  H.writeHistory('', [], fakeStore);
  return H.readHistory(H.carIdentity(car), fakeStore).length;
})(), 0);
check('storage is session-only', /window\.sessionStorage/.test(appjs) && !/localStorage/.test(appjs), true);
check('no answers are stored, only question and area',
  /\{ question, category: state\.category \}/.test(appjs), true);
check('history offers no re-submit control', /historyList[\s\S]{0,600}addEventListener/.test(appjs), false);

/* ---- display normalisation ---- */
const displayModel = new Function(`${src('displayModel')}; return displayModel;`)();
check('lower-case entry displays as a designation', displayModel('330 gtc'), '330 GTC');
check('mixed entry normalises', displayModel('330 GtC'), '330 GTC');
check('a word-style model is title-cased, not shouted', displayModel('daytona'), 'Daytona');
check('designations with a slash survive', displayModel('365 gtb/4'), '365 GTB/4');
check('the model sent to the server stays as typed',
  /car: state\.car/.test(appjs) && !/state\.car\.model = displayModel/.test(appjs), true);

/* ---- wording and controls ---- */
check('the source link reads View Source', /'View Source'/.test(appjs), true);
check('the old wording is gone', /View exact source/.test(appjs), false);
check('the judging area label drops the word judge',
  /text\(\$\('roleLabel'\), state\.category === 'Engine and Chassis'/.test(appjs), true);
check('Year is a text entry, not a number spinner',
  /id="carYear" type="text"/.test(html) && !/id="carYear"[^>]*type="number"/.test(html), true);
check('Year takes a numeric keypad and four characters',
  /id="carYear"[\s\S]{0,120}inputmode="numeric"[\s\S]{0,120}maxlength="4"/.test(html), true);
check('Set is visually dominant over Clear',
  /#setContext \{ min-width: 124px/.test(css) && /#clearInfo \{ min-width: 62px/.test(css), true);
check('the two controls are separated', /\.setup__actions \{ display: flex; align-items: center; gap: 18px/.test(css), true);
check('history is collapsed by default', /<details id="history"/.test(html) && !/<details id="history"[^>]*open/.test(html), true);


/* ---- v2.0.11: history gating, question display, year entry ---- */
const P = new Function(`${src('displayQuestion')}; ${src('historyVisible')}; ${src('sanitiseYear')}; ${src('shouldAdvanceFromYear')};
  return { displayQuestion, historyVisible, sanitiseYear, shouldAdvanceFromYear };`)();

// Year field
check('Year has no number spinner in the markup', /id="carYear"[^>]*type="number"/.test(html), false);
check('Year suppresses UA spinner controls in CSS',
  /-webkit-inner-spin-button/.test(css) && /appearance: textfield/.test(css), true);
check('Year requests a numeric mobile keyboard', /id="carYear"[\s\S]{0,140}inputmode="numeric"/.test(html), true);
check('Year is capped at four characters in the markup', /id="carYear"[\s\S]{0,140}maxlength="4"/.test(html), true);
check('Year accepts digits only', P.sanitiseYear('1a9b6c7d'), '1967');
check('Year accepts at most four digits', P.sanitiseYear('196789'), '1967');
check('four digits advance focus to Model', P.shouldAdvanceFromYear('1967'), true);
check('three digits do not advance focus', P.shouldAdvanceFromYear('196'), false);
check('advancing focus targets Model and does not Set',
  /shouldAdvanceFromYear\(cleaned\)\) \$\('carModel'\)\.focus\(\)/.test(appjs)
  && !/shouldAdvanceFromYear[\s\S]{0,120}establish\(\)/.test(appjs), true);

// History visibility
check('history is hidden before Set', P.historyVisible(false, 3), false);
check('history is hidden with zero questions', P.historyVisible(true, 0), false);
check('history appears once established and non-empty', P.historyVisible(true, 1), true);
check('reopening the setup panel hides history again',
  /function openSetup\(\)[\s\S]*?paintHistory\(\)/.test(appjs), true);
check('history is collapsed in the markup', /<details id="history"[^>]*open/.test(html), false);
check('history is re-collapsed on each Set', /\$\('history'\)\.open = false/.test(appjs), true);

// History content
check('each history item keeps its judging area', /area\.textContent = entry\.category/.test(appjs), true);
check('Engine and Chassis is shown with an ampersand',
  /entry\.category === 'Engine and Chassis' \? 'Engine & Chassis'/.test(appjs), true);
check('a lower-case question displays capitalised',
  P.displayQuestion('are the knock-off spinners allowed?'), 'Are the knock-off spinners allowed?');
check('wording is otherwise untouched',
  P.displayQuestion('Is this air cleaner correct?'), 'Is this air cleaner correct?');
check('an already-capitalised question is unchanged',
  P.displayQuestion('Are these wheels correct?'), 'Are these wheels correct?');
check('the stored question is the raw text, not the display form',
  /\{ question, category: state\.category \}/.test(appjs), true);

/* ---- Slice 1: curator-owned model_coverage (A.11) ----
   The value is read verbatim off the curated alias record. Judge-facing identity
   stays the judge's car; the coverage value is an internal retrieval key only. */
const { resolveModel } = await import(moduleUrl('src/services/vehicle-context.mjs'));

check('330 GTC resolves to the shared corpus coverage under ferrari-test',
  resolveModel('330 GTC', 'ferrari-test').model_coverage, '330 GTC/GTS');
check('an alias reaches the same coverage and still reports the matched alias',
  [resolveModel('F430 Scuderia', 'ferrari-test').model_coverage,
   resolveModel('F430 Scuderia', 'ferrari-test').matched_alias],
  ['430 Scuderia', 'F430 Scuderia']);
check('the production alias table carries no coverage, and none is invented',
  resolveModel('330 GTC').model_coverage, null);
check('the disabled 330 GTC/GTS bridge stays unresolvable despite valid coverage',
  resolveModel('330 GTC/GTS', 'ferrari-test').resolved, false);

/* ---- Slice 2: modelCoverage carried to the retrieval layer, not yet applied ---- */
const askjs = readFileSync(path.join(REPO, 'netlify/functions/ask.mjs'), 'utf8');
const judgingjs = readFileSync(path.join(REPO, 'src/services/openai-judging.mjs'), 'utf8');

check('coverage is taken from the resolved model, not derived',
  /modelCoverage = resolved\.model_coverage;/.test(askjs)
  && !/modelCoverage\s*=\s*resolved\.(canonical_model_name|document_designation)/.test(askjs), true);
check('ask.mjs passes coverage into askJudging',
  /askJudging\(\{[\s\S]*?\bmodelCoverage,[\s\S]*?\}\)/.test(askjs), true);
check('askJudging accepts coverage',
  /export async function askJudging\(\{[^}]*\bmodelCoverage\b[^}]*\}\)/.test(judgingjs), true);

/* ---- Slice 3: coverage becomes the file_search attribute filter ---- */
const { buildFileSearchTool } = await import(moduleUrl('src/services/openai-judging.mjs'));

check('without coverage the tool block is unchanged',
  [buildFileSearchTool('vs_x', 5, null), buildFileSearchTool('vs_x', 5, '')],
  [{ type: 'file_search', vector_store_ids: ['vs_x'], max_num_results: 5 },
   { type: 'file_search', vector_store_ids: ['vs_x'], max_num_results: 5 }]);
check('coverage produces an OR of brand_wide and the exact value, leaving the store and result count alone',
  buildFileSearchTool('vs_x', 5, '330 GTC/GTS'),
  { type: 'file_search', vector_store_ids: ['vs_x'], max_num_results: 5,
    filters: { type: 'or', filters: [
      { type: 'eq', key: 'scope', value: 'brand_wide' },
      { type: 'eq', key: 'model_coverage', value: '330 GTC/GTS' }] } });
check('matching is exact, so a variant is never reached through its family',
  [buildFileSearchTool('vs_x', 5, '430 Scuderia').filters.filters[1].value,
   buildFileSearchTool('vs_x', 5, 'F430').filters.filters[1].value,
   buildFileSearchTool('vs_x', 5, '430 Scuderia').filters.filters.some(f => f.key === 'model_family')],
  ['430 Scuderia', 'F430', false]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
