/**
 * Answer policy - v1.0 §31 server-side integrity checks, Addendum A.1 and A.10.
 *
 * The model's prose is a candidate, never the authority. Everything the judge sees
 * is validated here against the frozen manifest and the citation resolver.
 */

import { buildCitation } from './citation-resolver.mjs';
import { selectCitations } from './citation-selection.mjs';
import { pruneRedundantFields } from './answer-presentation.mjs';

/** Reviewed pages shown on a not-found result. Transparency, not a retrieval dump. */
const MAX_REVIEWED = 2;


/**
 * Is the answer's opening clause a statement that the CORPUS lacks the requested fact?
 *
 * Deliberately compositional rather than a list of sentences. A negative-corpus
 * statement is recognised by three parts appearing together in the first sentence:
 *
 *   subject   - the approved material ("documents", "sources", "corpus", "checklist")
 *   negation  - "no", "not", "n't", "lacks", "absent", "silent"
 *   provision - a word for stating or holding a fact ("specify", "contain", "provide",
 *               "information", "specification", ...)
 *
 * So "the documents reviewed do not specify", "the provided sources do not contain
 * specific information", "the approved documents do not provide" and "the corpus does
 * not state" all classify the same way, without anyone having to enumerate them.
 *
 * First sentence only, so a supported answer carrying a later caveat is unaffected.
 * This never manufactures an answer - it only stops a negative one being presented as
 * positive, and only when the model's own prose contradicts its reported status.
 */
const CORPUS_SUBJECT = /\b(documents?|sources?|corpus|records?|materials?|notes|guidelines?|checklists?|references?|documentation)\b/i;
const NEGATION = /\b(no|not|never|nothing|none|lacks?|lacking|absent|silent|without)\b|n't/i;
const PROVISION = /\b(specif(?:y|ies|ied|ication|ications)|states?|stated|contains?|contain|provides?|provide|describes?|describe|indicates?|indicate|addresses?|address|mentions?|mention|defines?|define|covers?|cover|lists?|includes?|include|information|details?|guidance|reference|find|found|locate|located|identif(?:y|ies|ied))\b/i;
/** "silent on X" carries the negation and the missing provision in one word. */
const SILENT = /\bsilent\b/i;

/** @returns {'corpus_negative'|null} */
export function classifyAnswerProse(answerText) {
  const first = String(answerText || '').trim().split(/(?<=[.!?])\s+/)[0] || '';
  if (!first) return null;
  if (CORPUS_SUBJECT.test(first) && SILENT.test(first)) return 'corpus_negative';
  const hasAll = CORPUS_SUBJECT.test(first) && NEGATION.test(first) && PROVISION.test(first);
  // "No information about X was found in the approved documents" - same shape.
  return hasAll ? 'corpus_negative' : null;
}

/** Kept as the named predicate used by the policy and its tests. */
export function statesNotFound(answerText) {
  return classifyAnswerProse(answerText) === 'corpus_negative';
}

/**
 * Resolve retrieval results into verified citations. Model claims are ignored.
 *
 * `supportingQuote` is the model's own exact quotation. It is used ONLY to narrow
 * which span of a retrieval result the resolver examines - never as evidence in
 * itself. A page-N unit carries page-(N-1) overlap text, so handing the resolver
 * the whole chunk makes an excerpt that physically originates on the previous page
 * resolve to page N. Passing the quote instead lets the resolver's existing
 * containment test attribute it to the page it actually came from (A.6).
 *
 * The quote is used only when it appears verbatim in that result under the
 * resolver's own normalization. No fuzzy matching, no model-supplied page numbers,
 * and a result is never rejected merely because the quote is absent from it - the
 * quote may legitimately belong to a different result in the same set.
 */
export function verifySources({ results, corpus: c, supportingQuote = null }) {
  const citations = [];
  const rejected = [];

  // Same normalization the citation resolver applies, so "contained verbatim"
  // means the same thing on both sides of the boundary.
  const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const quote = typeof supportingQuote === 'string' && supportingQuote.trim() !== ''
    ? supportingQuote : null;
  const normQuote = quote ? collapse(quote) : null;

  for (const r of results || []) {
    let unit = r.attributes?.unit_id ? c.unitById.get(r.attributes.unit_id) : null;
    let lookup = unit ? 'attribute' : null;
    if (!unit && r.filename) { unit = c.unitByFile.get(r.filename) || null; if (unit) lookup = 'filename_fallback'; }

    if (!unit) { rejected.push({ reason: 'not resolvable to the approved manifest', filename: r.filename || null }); continue; }

    const doc = c.docById.get(unit.document_id);
    // Every document_id must exist in the approved manifest (v1.0 §31).
    if (!doc || !doc.active || doc.redistribution_status !== 'approved') {
      rejected.push({ reason: 'document not active/approved in manifest', document_id: unit.document_id });
      continue;
    }

    // Narrow to the quote only when this result verifiably contains it; otherwise
    // fall back to the complete retrieval text exactly as before.
    const excerpt = normQuote && collapse(r.text).includes(normQuote) ? quote : r.text;

    const probe = buildCitation({ unit, excerpt, manifestDoc: doc, sliceExists: true });
    const slice = c.sliceExists(unit.document_id, probe.page_number);
    const cite = buildCitation({ unit, excerpt, manifestDoc: doc, sliceExists: slice });
    citations.push({ ...cite, score: r.score ?? null, lookup, primary_text: unit.primary_text });
  }

  // Deduplicate by document + page, keeping the strongest score.
  const byKey = new Map();
  for (const ct of citations) {
    const key = `${ct.document_id}#${ct.page_number ?? 'none'}`;
    const prev = byKey.get(key);
    if (!prev || (ct.score ?? 0) > (prev.score ?? 0)) byKey.set(key, ct);
  }
  const deduped = [...byKey.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    sources: deduped,
    verified: deduped.filter(s => s.page_verified),
    rejected,
  };
}

/**
 * Apply the policy. Returns the payload the frontend renders.
 * Never lets unsupported answer text reach the judge.
 */
export function applyPolicy({ parsed, sources, verified, rejected, duration_ms, model, car, category, question = '', corpusTexts = [], warnings = [], diagnostics = [] }) {
  let status = parsed?.status || 'ERROR';
  let answer = parsed?.answer ?? null;
  let reason = parsed?.reason ?? null;
  let correctSpecification = parsed?.correct_specification ?? null;

  const substantive = ['SUPPORTED', 'RELATED_HISTORICAL', 'CONFLICT'].includes(status);
  const stillSubstantive = () => ['SUPPORTED', 'RELATED_HISTORICAL', 'CONFLICT'].includes(status);

  // v1.0 §31: a substantive answer requires at least one verified source. If the
  // model asserted support with nothing verifiable behind it, the answer text is
  // discarded - not displayed with a caveat.
  if (substantive && sources.length === 0) {
    status = 'NO_SOURCE';
    answer = null; reason = null; correctSpecification = null;
    diagnostics.push('Model reported a supported answer with no resolvable source. Converted to NO_SOURCE.');
  }

  // Exact-source verification is mandatory. An answer supported only by citations
  // whose physical page could not be verified must not be presented as an official
  // source-supported answer with a "Page not verified" note beneath it. The sources
  // are still listed at document level so the judge can open them, but the
  // conclusion is withheld.
  if (stillSubstantive() && sources.length > 0 && verified.length === 0) {
    status = 'NO_VERIFIED_PAGE';
    answer = null; reason = null; correctSpecification = null;
    diagnostics.push('Supporting material was retrieved but no physical page could be verified for it, so the answer was withheld.');
  }

  // A page being retrieved and page-verified does not make it evidence FOR the answer.
  // When the answer itself says the corpus does not contain the requested
  // specification, present that as a not-found result rather than a supported one.
  // Any status may be overridden when the prose plainly contradicts it. The previous
  // gate only considered substantive statuses, so a model reporting INSUFFICIENT_INFO
  // with negative-corpus prose was never reclassified - the live steering-wheel case.
  // CONFLICT is excluded because it is about sources disagreeing, not absence.
  const OVERRIDABLE = ['SUPPORTED', 'RELATED_HISTORICAL', 'INSUFFICIENT_INFO', 'NO_SOURCE'];
  if (OVERRIDABLE.includes(status) && statesNotFound(answer)) {
    diagnostics.push(`Model reported ${parsed?.status}, but the answer states the documents do not contain the requested specification. Presented as NOT_FOUND.`);
    status = 'NOT_FOUND';
    correctSpecification = null;
    reason = null;
  }

  // A conflict must not be hidden behind a single-source SUPPORTED response.
  if (status === 'SUPPORTED') {
    const docs = new Set(sources.filter(s => s.page_verified).map(s => s.document_id));
    if (parsed?.conflict_note && docs.size > 1) {
      status = 'CONFLICT';
      diagnostics.push('Model supplied a conflict note; status raised to CONFLICT.');
    }
  }

  // A.1: the assistant never states a deduction, and A.10 forbids a score-sheet line
  // or maximum without an approved mapping. The mapping table is empty for this
  // corpus, so both fields are omitted entirely rather than shown as unknown.
  const deduction = { applicable: false, score_sheet_line: null, maximum_deduction: null };

  const judgeNote = stillSubstantive()
    ? 'The judge determines the actual deduction based on the applicable judging standards, authenticity, and condition.'
    : null;

  const labels = {
    SUPPORTED: 'Official source found',
    RELATED_HISTORICAL: 'Related historical source',
    CONFLICT: 'Conflicting source information',
    INSUFFICIENT_INFO: 'Insufficient information',
    NO_SOURCE: 'No supporting source found',
    NOT_FOUND: 'Not found in approved documents',
    NO_VERIFIED_PAGE: 'No verified source page',
    OUT_OF_SCOPE: 'Outside scope',
    ERROR: 'Could not complete the request',
  };

  const messages = {
    NO_SOURCE: 'I could not find a supported answer to this judging question in the approved source documents.',
    NOT_FOUND: 'The approved documents reviewed do not specify this.',
    OUT_OF_SCOPE: 'This assistant answers questions from the approved judging documents. This question appears to be outside that scope.',
    INSUFFICIENT_INFO: 'This question does not identify enough about what is being judged to return a sourced answer. Restate it naming the specific component.',
    NO_VERIFIED_PAGE: 'Supporting material was found in the approved documents, but its exact page could not be verified. An answer is not shown without a verified source page. The documents are listed below.',
  };

  // Presentation only, and deliberately last: status is already settled above, so
  // narrowing the displayed list can never change the verdict or trip the
  // no-verified-page fail-safe.
  const selection = stillSubstantive()
    ? selectCitations({
        citations: sources,
        question,
        answerText: [answer, correctSpecification, parsed?.conflict_note].filter(Boolean).join(' '),
        corpusTexts,
        category,
        status,
      })
    : { displayed: sources, suppressed: [], reason: 'not a substantive answer' };

  if (selection.suppressed.length) {
    // Retrieval diagnostics, not judge-facing. Citation selection still runs in full;
    // the count stays in the payload for diagnosis.
    diagnostics.push(`${selection.suppressed.length} further verified page(s) were retrieved but did not add support beyond those shown.`);
  }

  // Presentation, after selection so novelty can be grounded in the pages actually
  // cited. Only removes a block that carries no source-grounded fact of its own.
  const presentation = stillSubstantive()
    ? pruneRedundantFields({
        answer, question, correctSpecification, reason,
        // All VERIFIED sources, not just the displayed subset: a caveat may rest on a
        // verified page that citation selection judged duplicative for display.
        sourceTexts: verified.map(s => s.primary_text).filter(Boolean),
        titles: [...new Set(sources.map(s => s.display_title).filter(Boolean))],
        corpusTexts,
      })
    : { correct_specification: correctSpecification, reason, suppressed: [] };

  // For a not-found result the retrieved pages were REVIEWED, not relied on. They are
  // offered as limited transparency about what was checked - never as the affirmative
  // citation cards used for supporting evidence - and are capped so the judge is not
  // handed a retrieval dump.
  const notFoundLike = ['NOT_FOUND', 'NO_SOURCE'].includes(status);
  // Affirmative cards mean "this page supports the answer". Only a substantive answer
  // has support. NO_VERIFIED_PAGE keeps its document-level entries, which render as
  // unverified stamps rather than as evidence. INSUFFICIENT_INFO shows nothing at all:
  // the corpus was not the problem, so listing pages would imply it was.
  const affirmative = stillSubstantive() || status === 'NO_VERIFIED_PAGE';
  const displayedSources = affirmative ? selection.displayed : [];
  const reviewed = notFoundLike ? verified.slice(0, MAX_REVIEWED) : [];
  if (notFoundLike && verified.length > reviewed.length) {
    diagnostics.push(`${verified.length} page(s) were reviewed; ${reviewed.length} shown.`);
  }

  return {
    status,
    confidence_label: labels[status] || labels.ERROR,
    answer: answer || messages[status] || null,
    reason: stillSubstantive() ? presentation.reason : null,
    correct_specification: stillSubstantive() ? presentation.correct_specification : null,
    presentation_suppressed: presentation.suppressed,
    conflict_note: status === 'CONFLICT' ? (parsed?.conflict_note ?? null) : null,
    deduction,
    judge_note: judgeNote,
    car: car ? { year: car.year ?? null, model: car.model ?? null, concours_class: car.concours_class ?? null } : null,
    judging_category: category ?? null,
    sources: displayedSources.map(s => ({
      document_id: s.document_id,
      display_title: s.display_title,
      document_version: s.document_version,
      section_title: s.section_title,
      page_number: s.page_number,
      page_verified: s.page_verified,
      also_contains_page: s.also_contains_page ?? null,
      resolution: s.resolution,
      viewer_url: s.viewer_url,
    })),
    sources_reviewed: reviewed.map(s => ({
      document_id: s.document_id,
      display_title: s.display_title,
      page_number: s.page_number,
      page_verified: s.page_verified,
      viewer_url: s.viewer_url,
    })),
    sources_verified: verified.length,
    sources_displayed: selection.displayed.length,
    sources_suppressed: selection.suppressed.length,
    selection_reason: selection.reason,
    sources_rejected: rejected.length,
    instrumentation: { duration_ms, model, path: 'text_only' },
    warnings,
    diagnostics,
  };
}
