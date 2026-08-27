/**
 * Citation Resolver - Addendum A.6
 *
 * Turns a retrieved excerpt into a VERIFIED page citation, or suppresses the page.
 * Deterministic. No fuzzy matching. No model-supplied page numbers are ever trusted.
 *
 *   Retrieval Layer -> Source Identity -> Citation Resolver -> Original PDF + Page
 *
 * The resolver depends on stable source identifiers and page metadata, not on the
 * fact that retrieval currently happens to be page-level.
 */

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

export const RESOLUTION = {
  PRIMARY: 'RESOLVED_PRIMARY',       // excerpt originates on this unit's page
  OVERLAP: 'RESOLVED_OVERLAP_ORIGIN',// excerpt originates on the previous page
  SPANNING: 'SUPPRESSED_SPANNING',   // excerpt crosses the boundary - page ambiguous
  UNMATCHED: 'SUPPRESSED_UNMATCHED', // excerpt not found in the unit at all
};

/**
 * @param {object} unit  a record from build/<brand>/retrieval-units.json
 * @param {string} excerpt  verbatim supporting text returned by retrieval
 * @returns {{page_number:number|null, resolution:string, page_verified:boolean}}
 */
export function resolveCitation(unit, excerpt) {
  const needle = collapse(excerpt);
  if (!needle) return { page_number: null, resolution: RESOLUTION.UNMATCHED, page_verified: false };

  const primary = collapse(unit.primary_text);
  const overlap = collapse(unit.overlap_span);

  const inPrimary = primary.includes(needle);
  const inOverlap = overlap ? overlap.includes(needle) : false;

  // Overlap is retrieval context ONLY. It must never change page attribution:
  // text that physically originates on page 14 is cited to page 14 even when it
  // appears inside the page-15 unit.
  if (inOverlap && !inPrimary) {
    return { page_number: unit.overlap_origin_page, resolution: RESOLUTION.OVERLAP, page_verified: true };
  }
  if (inPrimary && !inOverlap) {
    return { page_number: unit.page_number, resolution: RESOLUTION.PRIMARY, page_verified: true };
  }
  if (inPrimary && inOverlap) {
    // Duplicate text in both spans - genuinely ambiguous. Prefer the origin page only
    // if the overlap span uniquely contains it; otherwise suppress.
    return { page_number: null, resolution: RESOLUTION.SPANNING, page_verified: false };
  }
  // Spans the boundary or is not present verbatim (e.g. the model paraphrased).
  return { page_number: null, resolution: RESOLUTION.SPANNING, page_verified: false };
}

/**
 * Full acceptance gate - Addendum A.6 citation acceptance criteria 1-7.
 * Returns a citation safe to display, with the page suppressed if unverifiable.
 */
export function buildCitation({ unit, excerpt, manifestDoc, sliceExists }) {
  const r = resolveCitation(unit, excerpt);

  const criteria = {
    original_pdf_exists: Boolean(manifestDoc),
    document_id_resolves: Boolean(manifestDoc && manifestDoc.document_id === unit.document_id),
    page_exists_in_pdf: r.page_number !== null && manifestDoc ? r.page_number >= 1 && r.page_number <= manifestDoc.page_count : false,
    text_originates_on_page: r.page_verified,
    no_runtime_fuzzy_matching: true,
    no_duplicate_page_ambiguity: r.resolution !== RESOLUTION.SPANNING,
    viewer_can_open_page: Boolean(sliceExists),
  };
  const allMet = Object.values(criteria).every(Boolean);

  return {
    document_id: unit.document_id,
    display_title: unit.document_title,
    document_version: unit.document_version,
    section_title: unit.section_heading || null,
    page_number: allMet ? r.page_number : null,
    page_verified: allMet,
    resolution: r.resolution,
    criteria,
    viewer_url: allMet
      ? `/source/${unit.document_id}/page/${r.page_number}`
      : `/source/${unit.document_id}`,
    unit_id: unit.unit_id,
  };
}
