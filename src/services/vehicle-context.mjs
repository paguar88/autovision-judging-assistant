/**
 * Vehicle identity - Addendum A.11.
 *
 * Spoken model terminology is normalized through the CURATED alias table before
 * retrieval. The application matches against the table; it never creates entries.
 * A wrong year is more dangerous than an unknown alias, because retrieval may
 * return a fully sourced answer valid for a different car.
 */

import { corpus } from './corpus.mjs';

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim();

/**
 * @returns {{resolved:boolean, canonical_model_name?:string, document_designation?:string,
 *            model_coverage?:string|null, matched_alias?:string|null, model_id?:string,
 *            message?:string}}
 */
export function resolveModel(spoken, brand = 'ferrari') {
  const { aliases } = corpus(brand);
  const needle = norm(spoken);
  if (!needle) return { resolved: false, message: 'No model was supplied.' };

  for (const m of aliases.models.filter(x => x.active)) {
    const candidates = [m.canonical_model_name, m.document_designation, ...(m.aliases || [])];
    const hit = candidates.find(c => norm(c) === needle);
    if (hit) {
      return {
        resolved: true,
        model_id: m.model_id,
        canonical_model_name: m.canonical_model_name,
        document_designation: m.document_designation,
        // Curator-owned retrieval key (Tier 2). Read verbatim off the alias record
        // and never derived - not from the canonical name, the document
        // designation, the model family, or corpus documents. A missing value
        // stays null so the caller can fail closed; a fallback here would
        // silently filter for the wrong set of documents.
        model_coverage: m.model_coverage ?? null,
        matched_alias: norm(hit) === norm(m.canonical_model_name) ? null : hit,
        approved_year_start: m.approved_year_start,
        approved_year_end: m.approved_year_end,
        year_range_authoritative: Boolean(m.year_range_authoritative),
      };
    }
  }

  // Wording must not overclaim: the check is against the alias table, not the corpus.
  return {
    resolved: false,
    message: 'That model is not currently covered by the configured model list. Please check the model designation, or ask about a model in the approved list.',
  };
}

/** Advisory only - never a gate, never substitutes a year (A.11). */
export function validateYear(year, resolvedModel) {
  if (!year || !resolvedModel?.resolved) return null;
  const y = parseInt(year, 10);
  const { approved_year_start: a, approved_year_end: b } = resolvedModel;
  if (!a || !b || Number.isNaN(y)) return null;
  if (y >= a && y <= b) return null;
  return {
    code: 'YEAR_OUTSIDE_RANGE',
    message: 'The selected year is outside the approved year range currently configured for this model. Please verify the year/model before relying on judging guidance.',
    configured_range: `${a}-${b}`,
    authoritative: Boolean(resolvedModel.year_range_authoritative),
  };
}

/** Display string for the context strip (A.9). */
export function describeCar(car) {
  if (!car?.model) return 'No car selected';
  const bits = [car.year, 'Ferrari', car.model].filter(Boolean).join(' ');
  return car.concours_class ? `${bits} · ${car.concours_class}` : bits;
}
