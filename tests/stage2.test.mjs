#!/usr/bin/env node
/**
 * Stage 2 regression tests - guards, vehicle identity, and answer policy.
 * Offline. No network, no OpenAI, no Netlify runtime.
 */

import { checkStandalone } from '../src/services/ellipsis-guard.mjs';
import { resolveModel, validateYear } from '../src/services/vehicle-context.mjs';
import { verifySources, applyPolicy } from '../src/services/answer-policy.mjs';
import { corpus } from '../src/services/corpus.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
};

console.log('\n=== STAGE 2 TESTS ===\n--- standalone question guard (A.12) ---');
for (const q of ['what about the rear ones?', 'And the other one?', 'is that correct', 'Are those right?', 'What about them']) {
  check(`blocks: "${q}"`, checkStandalone(q).ok, false);
}
for (const q of [
  'Are the knock-off spinners correct?',
  'What wheels are correct for this car?',
  'Should the valve cover be black crinkle paint?',
  'Is the ANSA exhaust correct?',
]) {
  check(`allows: "${q}"`, checkStandalone(q).ok, true);
}
check('blocks empty input', checkStandalone('  ').ok, false);
check('blocks over-long input', checkStandalone('a'.repeat(700)).ok, false);
check('nudge is inline wording, not an answer', /name the component/.test(checkStandalone('what about those?').message), true);

console.log('\n--- vehicle identity (A.11) ---');
check('canonical designation resolves', resolveModel('330 GTC').document_designation, '330 GTC');
check('curated alias normalizes to designation', resolveModel('Daytona').document_designation, '365 GTB/4');
check('alias is disclosed, not silently rewritten', resolveModel('Daytona').matched_alias, 'Daytona');
check('case and spacing tolerated by the alias match', resolveModel('  330gtc ').canonical_model_name, '330 GTC');
check('330GTC alias resolves', resolveModel('330GTC').canonical_model_name, '330 GTC');
check('unknown model is not guessed', resolveModel('250 GTO').resolved, false);
check('unknown wording does not overclaim the corpus',
  /not currently covered by the configured model list/.test(resolveModel('250 GTO').message), true);

const gtc = resolveModel('330 GTC');
check('year inside range raises nothing', validateYear(1967, gtc), null);
check('year outside range is advisory, not a gate', validateYear(1985, gtc).code, 'YEAR_OUTSIDE_RANGE');
check('advisory does not substitute a year', Object.hasOwn(validateYear(1985, gtc), 'substituted_year'), false);

console.log('\n--- answer policy (v1.0 §31, A.1, A.10) ---');
const c = corpus('ferrari');
const B = path.join(process.cwd(), 'build/ferrari');
const unit = c.unitById.get('ferrari-330-gtc-gts-as-built:p59');
const chunk = readFileSync(path.join(B, 'retrieval-units', unit.unit_file), 'utf8');

const live = verifySources({
  results: [{ attributes: { unit_id: unit.unit_id }, text: chunk, score: 0.9 }],
  corpus: c,
});
check('live-shape result verifies to its physical page',
  [live.verified.length, live.sources[0].page_number, live.sources[0].resolution],
  [1, 59, 'RESOLVED_PRIMARY']);

const forged = verifySources({
  results: [{ attributes: { unit_id: 'not-a-real-unit:p1' }, text: 'anything', score: 0.9 }],
  corpus: c,
});
check('source outside the approved manifest is rejected', [forged.sources.length, forged.rejected.length], [0, 1]);

const unsupported = applyPolicy({
  parsed: { status: 'SUPPORTED', answer: 'The spinners are correct.', reason: 'r', correct_specification: 's', supporting_quote: null, conflict_note: null },
  sources: [], verified: [], rejected: [], duration_ms: 100, model: 'test', car: null, category: null,
});
check('SUPPORTED with no source becomes NO_SOURCE', unsupported.status, 'NO_SOURCE');
check('unsupported answer text is discarded, not caveated',
  [unsupported.reason, unsupported.correct_specification], [null, null]);

const good = applyPolicy({
  parsed: { status: 'SUPPORTED', answer: 'Borrani or Campagnolo.', reason: 'r', correct_specification: 'spec', supporting_quote: 'q', conflict_note: null },
  sources: live.sources, verified: live.verified, rejected: [], duration_ms: 3000, model: 'test',
  car: { year: '1967', model: '330 GTC', concours_class: 'Regular' }, category: 'Exterior',
});
check('supported answer keeps its verified source', good.sources[0].page_verified, true);
check('no deduction is ever stated (A.1)', good.deduction.applicable, false);
check('no score-sheet line without a curated mapping (A.10)',
  [good.deduction.score_sheet_line, good.deduction.maximum_deduction], [null, null]);
check('judge retains the determination', /judge determines the actual deduction/.test(good.judge_note), true);
check('viewer URL is addressable', good.sources[0].viewer_url, '/source/ferrari-330-gtc-gts-as-built/page/59');
check('instrumentation records the text-only path', good.instrumentation.path, 'text_only');

check('score-sheet mapping table is still empty', c.mappings.mappings.length, 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
