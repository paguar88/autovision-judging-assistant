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
import { verifySources } from '../src/services/answer-policy.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// 7b. LIVE-SHAPE CASES. File search returns the whole chunk, not a hand-picked
//     fragment. For page-level units the chunk is the entire unit file: ingestion's
//     header, the labelled overlap block, then the page text. These cases reproduce
//     the live payload exactly and are the regression that was missing.
{
  const unitFile = (u) => readFileSync(path.join(B, 'retrieval-units', u.unit_file), 'utf8');

  const withOverlap = unitOf('ferrari-330-gtc-gts-as-built:p59');
  const c1 = cite(withOverlap.unit_id, unitFile(withOverlap));
  check('whole unit file (with overlap block) -> page 59, verified',
    [c1.page_number, c1.page_verified, c1.resolution],
    [59, true, RESOLUTION.PRIMARY]);
  check('overlap presence is disclosed, not hidden', c1.also_contains_page, 58);

  const noOverlap = unitOf('ferrari-330-gtc-gts-checklist:p1');
  const c2 = cite(noOverlap.unit_id, unitFile(noOverlap));
  check('whole unit file (no overlap block) -> page 1, verified',
    [c2.page_number, c2.page_verified, c2.resolution],
    [1, true, RESOLUTION.PRIMARY]);

  // A chunk truncated to the overlap block alone still cites the ORIGIN page.
  const overlapOnlyChunk = `[continues from page 58]\n${withOverlap.overlap_span}`;
  const c3 = cite(withOverlap.unit_id, overlapOnlyChunk);
  check('chunk containing only the overlap block -> page 58, not 59',
    [c3.page_number, c3.resolution], [58, RESOLUTION.OVERLAP]);

  // If only the PAGE text is mutated but the overlap block survives verbatim, the
  // one span genuinely present is the previous page's - so page 58 is the correct
  // citation, not a suppression.
  const primaryMutated = unitFile(withOverlap).replace(/wheel/gi, 'rim').replace(/knockoff/gi, 'spinner');
  const c4 = cite(withOverlap.unit_id, primaryMutated);
  check('page text mutated, overlap intact -> cites page 58 (the span actually present)',
    [c4.page_number, c4.resolution], [58, RESOLUTION.OVERLAP]);

  // Integrity floor: when NEITHER span survives verbatim, the page must be suppressed.
  const bothMutated = primaryMutated.replace(/washer/gi, 'grommet').replace(/Lobo/g, 'Acme');
  const c5 = cite(withOverlap.unit_id, bothMutated);
  check('no span present verbatim -> page suppressed, document retained',
    [c5.page_number, c5.page_verified, c5.document_id],
    [null, false, 'ferrari-330-gtc-gts-as-built']);

  // Self-verification splits on whether a page carries extractable text.
  //
  // A text-bearing unit must verify to its OWN physical page: that is the citation
  // guarantee the product rests on.
  //
  // An image-only page has no primary_text, so there is nothing for the resolver to
  // match. Such a unit may legitimately resolve to its preceding overlap-origin page
  // or suppress the page number entirely - both are honest. What it must never do is
  // report page_verified for its own page, because that would assert textual support
  // on a page that contains none. Requiring all 591 to self-verify would have forced
  // exactly that false claim on the 36 image-only pages.
  //
  // Counts are asserted alongside the outcomes so a corpus that silently shrank, or
  // one whose text/image split moved, cannot pass with nothing left to verify.
  const textBearing = units.filter(u => (u.primary_text || '').trim() !== '');
  const blank = units.filter(u => (u.primary_text || '').trim() === '');

  const textUnresolved = textBearing.filter(u => {
    const r = cite(u.unit_id, unitFile(u));
    return !(r.page_verified && r.page_number === u.page_number);
  });
  const blankSelfVerified = blank.filter(u => {
    const r = cite(u.unit_id, unitFile(u));
    return r.page_verified && r.page_number === u.page_number;
  });

  check('every text-bearing unit verifies to its own page; image-only units never claim theirs',
    [units.length, textBearing.length, textUnresolved.length, blank.length, blankSelfVerified.length],
    [591, 555, 0, 36, 0]);
}

// 8. Every unit's declared page exists in its document and has a slice. This holds
//    for image-only pages too: they are still deliverable pages with real slices.
{
  const broken = units.filter(u => {
    const d = docOf(u.document_id);
    return !d || u.page_number < 1 || u.page_number > d.page_count || !sliceFor(u.document_id, u.page_number);
  });
  check('all 591 units have an in-range page with a generated slice',
    [units.length, broken.length], [591, 0]);
}

// 9. Citation Repair Slice 1: the model's exact supporting_quote narrows WHICH span
//    of a retrieval result the resolver examines.
//
//    A page-18 unit carries page-17 overlap text. Handing the resolver the complete
//    chunk makes it resolve to page 18, because the page-18 primary text is present
//    too - so a judge following the citation lands on a page that does not contain
//    the sentence the answer rested on. Passing the quote instead lets the existing
//    containment test attribute it to the page it physically came from.
//
//    The quote is a span selector, never evidence: page numbers still come only from
//    the resolver, matching is verbatim under the resolver's own normalization, and a
//    result is never rejected merely because the quote is absent from it.
{
  const u18 = unitOf('ferrari-330-gtc-gts-as-built:p18');
  const wholeChunk = `${u18.overlap_span}\n${u18.primary_text}`;
  const overlapQuote = u18.overlap_span.split('\n')[0].trim();      // page 17 text
  const primaryQuote = u18.primary_text.split('\n')[0].trim();      // page 18 text

  const c = {
    unitById: new Map(units.map(u => [u.unit_id, u])),
    unitByFile: new Map(units.map(u => [u.unit_file, u])),
    docById: new Map(manifest.map(d => [d.document_id, d])),
    sliceExists: (docId, page) => sliceFor(docId, page),
  };
  const verify = (supportingQuote) => verifySources({
    results: [{ attributes: { unit_id: u18.unit_id }, text: wholeChunk, score: 1 }],
    corpus: c,
    supportingQuote,
  }).sources[0];

  const overlapCase = verify(overlapQuote);
  check('a quote found only in the overlap resolves to the origin page and opens /page/17',
    [overlapCase.page_number, overlapCase.resolution, overlapCase.page_verified, overlapCase.viewer_url],
    [17, RESOLUTION.OVERLAP, true, `/source/${u18.document_id}/page/17`]);

  const primaryCase = verify(primaryQuote);
  check('a quote found only in the primary text resolves to the unit\'s own page',
    [primaryCase.page_number, primaryCase.resolution], [18, RESOLUTION.PRIMARY]);

  // Fallback: with no usable quote the complete result text is passed exactly as
  // before, so the pre-existing behaviour is preserved rather than merely similar.
  const baseline = verify(null);
  const fallbacks = [null, undefined, '', '   ', 'a sentence that appears nowhere in this unit']
    .map(q => { const s = verify(q); return [s.page_number, s.resolution]; });
  check('null, blank and non-matching quotes all preserve the complete-result fallback',
    fallbacks, Array(5).fill([baseline.page_number, baseline.resolution]));

  // A result that simply does not contain the quote is still cited, not discarded:
  // the quote may belong to a different result in the same set.
  const other = verifySources({
    results: [{ attributes: { unit_id: 'ferrari-330-gtc-gts-checklist:p1' }, text: unitOf('ferrari-330-gtc-gts-checklist:p1').primary_text, score: 1 }],
    corpus: c,
    supportingQuote: overlapQuote,
  });
  check('a result lacking the quote is still cited, not rejected',
    [other.sources.length, other.rejected.length], [1, 0]);

  const askjs = readFileSync(path.join(ROOT, 'netlify/functions/ask.mjs'), 'utf8');
  check('ask.mjs passes the model supporting_quote into verifySources',
    /verifySources\(\{[\s\S]*?supportingQuote:\s*parsed\.supporting_quote[\s\S]*?\}\)/.test(askjs), true);
}

// 10. Citation Repair Slice 2: printed document pages vs physical PDF pages.
//
//     A PDF's physical order and the numbers PRINTED on its pages are different
//     facts. The 458 brochure prints "4" on its third sheet. page_number and every
//     viewer URL stay physical, because that is what opens the right sheet;
//     printed_page_number rides alongside for the label the judge reads.
//
//     Nothing here is inferred: the mapping is curator-owned, the resolver never
//     computes a printed page, and an unmapped document reports null.
{
  const { printedPageFor, validatePrintedPageRanges } = await import('../src/services/printed-pages.mjs');
  const R458 = [{ physical_start: 3, physical_end: 34, printed_start: 4 }];
  const R430 = [{ physical_start: 6, physical_end: 136, printed_start: 4 }];

  check('458 physical page 17 maps to printed page 18, and 430 physical 51 to printed 49',
    [printedPageFor(17, R458), printedPageFor(51, R430)], [18, 49]);

  check('pages outside a range, and documents with no mapping, report null',
    [printedPageFor(2, R458), printedPageFor(137, R430), printedPageFor(2, null)],
    [null, null, null]);

  check('invalid and overlapping mappings are rejected',
    [ validatePrintedPageRanges('nope', { declaredPageCount: 34 }).length > 0,
      validatePrintedPageRanges([{ physical_start: -1, physical_end: 5, printed_start: 1 }], { declaredPageCount: 34 }).length > 0,
      validatePrintedPageRanges([{ physical_start: 10, physical_end: 4, printed_start: 1 }], { declaredPageCount: 34 }).length > 0,
      validatePrintedPageRanges([{ physical_start: 3, physical_end: 99, printed_start: 4 }], { declaredPageCount: 34 }).length > 0,
      validatePrintedPageRanges([{ physical_start: 3, physical_end: 10, printed_start: 4 },
                                 { physical_start: 8, physical_end: 12, printed_start: 20 }], { declaredPageCount: 34 }).length > 0,
      validatePrintedPageRanges(R458, { declaredPageCount: 34 }).length === 0 ],
    [true, true, true, true, true, true]);

  // Evidence originating in the previous page's overlap must report the ORIGIN
  // page in both systems: physical 17 and printed 18, opening /page/17.
  const u18 = unitOf('ferrari-330-gtc-gts-as-built:p18');
  const mapped = {
    ...u18,
    printed_page_number: printedPageFor(u18.page_number, R458),
    overlap_origin_printed_page: printedPageFor(u18.overlap_origin_page, R458),
  };
  const cMapped = {
    unitById: new Map([[mapped.unit_id, mapped]]),
    unitByFile: new Map(),
    docById: new Map(manifest.map(d => [d.document_id, d])),
    sliceExists: (docId, page) => sliceFor(docId, page),
  };
  const overlapSrc = verifySources({
    results: [{ attributes: { unit_id: mapped.unit_id }, text: `${u18.overlap_span}\n${u18.primary_text}`, score: 1 }],
    corpus: cMapped,
    supportingQuote: u18.overlap_span.split('\n')[0].trim(),
  }).sources[0];
  check('overlap evidence returns physical 17, printed 18, and a viewer URL on the physical page',
    [overlapSrc.page_number, overlapSrc.printed_page_number, overlapSrc.viewer_url],
    [17, 18, `/source/${u18.document_id}/page/17`]);

  // The 330 documents carry no mapping, so their citations must be untouched.
  const c330 = {
    unitById: new Map(units.map(u => [u.unit_id, u])),
    unitByFile: new Map(units.map(u => [u.unit_file, u])),
    docById: new Map(manifest.map(d => [d.document_id, d])),
    sliceExists: (docId, page) => sliceFor(docId, page),
  };
  const u1 = unitOf('ferrari-330-gtc-gts-checklist:p2');
  const plain = verifySources({
    results: [{ attributes: { unit_id: u1.unit_id }, text: u1.primary_text, score: 1 }],
    corpus: c330,
  }).sources[0];
  check('330 citations are unchanged: physical page, null printed page, physical viewer URL',
    [plain.page_number, plain.printed_page_number ?? null, plain.viewer_url],
    [2, null, `/source/${u1.document_id}/page/2`]);

  // The frontend labels with printed numbers but must never route with one.
  const appjs = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  check('the frontend never passes a printed page to the source route',
    [/\/source\/\$\{encodeURIComponent\(documentId\)\}\/page\/\$\{page\}/.test(appjs),
     /\/page\/\$\{printed/.test(appjs),
     /Printed page \$\{printed\} · PDF page \$\{page\} of \$\{pageCount\}/.test(appjs),
     /`Page \$\{page\} of \$\{pageCount\}`/.test(appjs)],
    [true, false, true, true]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
