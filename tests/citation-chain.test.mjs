#!/usr/bin/env node
/**
 * MACHINERY REGRESSION TEST - Addendum A.8
 *
 * Proves the citation chain: excerpt in -> expected document -> expected page ->
 * View Exact Source opens the right slice. Requires no network and no OpenAI.
 *
 * This proves NOTHING about judging truth. The judging golden case requires the
 * Ferrari Judging Committee's approved corpus and a qualified judge's certification.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildCitation, RESOLUTION } from '../src/services/citation-resolver.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const B = path.join(ROOT, 'build/ferrari');
const units = JSON.parse(readFileSync(path.join(B, 'retrieval-units.json'), 'utf8')).units;
const manifest = JSON.parse(readFileSync(path.join(B, 'document-manifest.json'), 'utf8')).documents;

const unitOf = (id) => units.find(u => u.unit_id === id);
const docOf = (id) => manifest.find(d => d.document_id === id);
const sliceFor = (docId, page) =>
  page !== null && existsSync(path.join(B, 'page-slices', docId, `p${String(page).padStart(4, '0')}.pdf`));

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}

function cite(unitId, excerpt) {
  const unit = unitOf(unitId);
  const doc = docOf(unit.document_id);
  // slice lookup uses the RESOLVED page, so probe both then rebuild
  const probe = buildCitation({ unit, excerpt, manifestDoc: doc, sliceExists: true });
  return buildCitation({ unit, excerpt, manifestDoc: doc, sliceExists: sliceFor(unit.document_id, probe.page_number) });
}

console.log('\n=== CITATION CHAIN MACHINERY TEST ===\n');

// 1. Text originating on the unit's own page resolves to that page.
{
  const c = cite('ferrari-330-gtc-gts-as-built:p59', 'The disk wheel should be a 14-inch Campagnolo cast alloy');
  check('as-built p59 primary text -> page 59, verified',
    [c.document_id, c.page_number, c.page_verified, c.resolution],
    ['ferrari-330-gtc-gts-as-built', 59, true, RESOLUTION.PRIMARY]);
  check('as-built p59 viewer URL targets the verified page', c.viewer_url, '/source/ferrari-330-gtc-gts-as-built/page/59');
}

// 2. THE CRITICAL A.6 CASE: text that appears inside the page-59 unit as overlap but
//    physically originates on page 58 must be cited to page 58, never 59.
{
  const u = unitOf('ferrari-330-gtc-gts-as-built:p59');
  const overlapOnly = u.overlap_span.split('\n').find(l => l.length > 40);
  const c = cite('ferrari-330-gtc-gts-as-built:p59', overlapOnly);
  check('overlap text retrieved from the p59 unit -> cited to page 58',
    [c.page_number, c.page_verified, c.resolution],
    [58, true, RESOLUTION.OVERLAP]);
}

// 3. Paraphrase / text absent from the unit -> page suppressed, document still cited.
{
  const c = cite('ferrari-330-gtc-gts-as-built:p59',
    'The wheels were generally of a sporting character appropriate to the period.');
  check('paraphrased excerpt -> page suppressed, document retained',
    [c.document_id, c.page_number, c.page_verified],
    ['ferrari-330-gtc-gts-as-built', null, false]);
  check('suppressed citation falls back to document-level viewer URL',
    c.viewer_url, '/source/ferrari-330-gtc-gts-as-built');
}

// 4. Checklist page 1 resolves and its slice opens.
{
  const c = cite('ferrari-330-gtc-gts-checklist:p1',
    'The items will be judged for originality, authenticity and condition');
  check('checklist p1 -> page 1, verified, slice present',
    [c.page_number, c.page_verified, c.criteria.viewer_can_open_page],
    [1, true, true]);
}

// 5. Guidelines: the 100-point basis and 0-5 deduction range (foundation of A.1).
{
  const c = cite('iacpfa-judging-guidelines:p1',
    'each car is assumed to have a perfect score of 100 points');
  check('guidelines p1 -> page 1, verified',
    [c.document_id, c.page_number, c.page_verified],
    ['iacpfa-judging-guidelines', 1, true]);
}

// 6. Every acceptance criterion is explicitly met on a good citation.
{
  const c = cite('ferrari-330-gtc-gts-as-built:p59', 'Borrani wire wheels should have a Borrani hand decal');
  check('all seven A.6 acceptance criteria met', Object.values(c.criteria).every(Boolean), true);
}

// 7. Cross-document page reference integrity: checklist exterior item 20 cites
//    As-Built page 59, and page 59 genuinely concerns wheels and knock-offs.
{
  const p59 = unitOf('ferrari-330-gtc-gts-as-built:p59').primary_text.toLowerCase();
  check('checklist page-59 reference lands on wheel/knock-off content',
    ['knockoff', 'borrani', 'campagnolo'].every(t => p59.includes(t)), true);
}

// 8. Every unit's declared page exists in its document and has a slice.
{
  const broken = units.filter(u => {
    const d = docOf(u.document_id);
    return !d || u.page_number < 1 || u.page_number > d.page_count || !sliceFor(u.document_id, u.page_number);
  });
  check('all 155 units have an in-range page with a generated slice', broken.length, 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
