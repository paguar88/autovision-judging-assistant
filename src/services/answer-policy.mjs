/**
 * Answer policy - v1.0 §31 server-side integrity checks, Addendum A.1 and A.10.
 *
 * The model's prose is a candidate, never the authority. Everything the judge sees
 * is validated here against the frozen manifest and the citation resolver.
 */

import { buildCitation } from './citation-resolver.mjs';

/** Resolve retrieval results into verified citations. Model claims are ignored. */
export function verifySources({ results, corpus: c }) {
  const citations = [];
  const rejected = [];

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

    const probe = buildCitation({ unit, excerpt: r.text, manifestDoc: doc, sliceExists: true });
    const slice = c.sliceExists(unit.document_id, probe.page_number);
    const cite = buildCitation({ unit, excerpt: r.text, manifestDoc: doc, sliceExists: slice });
    citations.push({ ...cite, score: r.score ?? null, lookup });
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
export function applyPolicy({ parsed, sources, verified, rejected, duration_ms, model, car, category, warnings = [] }) {
  let status = parsed?.status || 'ERROR';
  let answer = parsed?.answer ?? null;
  let reason = parsed?.reason ?? null;
  let correctSpecification = parsed?.correct_specification ?? null;

  const substantive = ['SUPPORTED', 'RELATED_HISTORICAL', 'CONFLICT'].includes(status);

  // v1.0 §31: a substantive answer requires at least one verified source. If the
  // model asserted support with nothing verifiable behind it, the answer text is
  // discarded - not displayed with a caveat.
  if (substantive && sources.length === 0) {
    status = 'NO_SOURCE';
    answer = null; reason = null; correctSpecification = null;
    warnings.push('Model reported a supported answer with no resolvable source. Converted to NO_SOURCE.');
  }

  // A conflict must not be hidden behind a single-source SUPPORTED response.
  if (status === 'SUPPORTED') {
    const docs = new Set(sources.filter(s => s.page_verified).map(s => s.document_id));
    if (parsed?.conflict_note && docs.size > 1) {
      status = 'CONFLICT';
      warnings.push('Model supplied a conflict note; status raised to CONFLICT.');
    }
  }

  // A.1: the assistant never states a deduction, and A.10 forbids a score-sheet line
  // or maximum without an approved mapping. The mapping table is empty for this
  // corpus, so both fields are omitted entirely rather than shown as unknown.
  const deduction = { applicable: false, score_sheet_line: null, maximum_deduction: null };

  const judgeNote = substantive
    ? 'The judge determines the actual deduction based on the applicable judging standards, authenticity, and condition.'
    : null;

  const labels = {
    SUPPORTED: 'Official source found',
    RELATED_HISTORICAL: 'Related historical source',
    CONFLICT: 'Conflicting source information',
    INSUFFICIENT_INFO: 'Insufficient information',
    NO_SOURCE: 'No supporting source found',
    OUT_OF_SCOPE: 'Outside scope',
    ERROR: 'Could not complete the request',
  };

  const messages = {
    NO_SOURCE: 'I could not find a supported answer to this judging question in the approved source documents.',
    OUT_OF_SCOPE: 'This assistant answers questions from the approved judging documents. This question appears to be outside that scope.',
    INSUFFICIENT_INFO: 'The available information is not enough to support a sourced answer.',
  };

  return {
    status,
    confidence_label: labels[status] || labels.ERROR,
    answer: answer || messages[status] || null,
    reason: substantive ? reason : null,
    correct_specification: substantive ? correctSpecification : null,
    conflict_note: status === 'CONFLICT' ? (parsed?.conflict_note ?? null) : null,
    deduction,
    judge_note: judgeNote,
    car: car ? { year: car.year ?? null, model: car.model ?? null, concours_class: car.concours_class ?? null } : null,
    judging_category: category ?? null,
    sources: sources.map(s => ({
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
    sources_verified: verified.length,
    sources_rejected: rejected.length,
    instrumentation: { duration_ms, model, path: 'text_only' },
    warnings,
  };
}
