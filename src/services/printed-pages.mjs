/**
 * Printed page mapping - Citation Repair Slice 2.
 *
 * A PDF's physical page order and the page numbers PRINTED on those pages are
 * different facts. A brochure with two unnumbered cover leaves prints "4" on its
 * third physical page. A judge reading "page 18" in a document means the printed
 * folio; the viewer needs the physical page to open the right sheet.
 *
 * Both are kept, and neither is inferred. The mapping is curator-owned Tier 2
 * configuration (A.2): ingestion may VALIDATE it against detected folios and must
 * never DECIDE it. A document with no configured mapping has no printed page -
 * null, never a guess.
 *
 * This module is the only place a printed page is calculated. The citation
 * resolver never computes one: it resolves physical pages from verbatim text
 * containment, and printed numbers are attached afterwards from this mapping.
 */

/**
 * Validate a curated printed_page_ranges array.
 * @returns {string[]} human-readable problems; empty means valid.
 */
export function validatePrintedPageRanges(ranges, { declaredPageCount = null } = {}) {
  const errors = [];
  if (ranges === undefined || ranges === null) return errors;   // absent is legal

  if (!Array.isArray(ranges)) return ['printed_page_ranges must be an array'];

  const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
  const seen = [];

  ranges.forEach((r, i) => {
    const at = `printed_page_ranges[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`${at} must be an object`); return; }

    for (const key of ['physical_start', 'physical_end', 'printed_start']) {
      if (!isPositiveInt(r[key])) errors.push(`${at}.${key} must be a positive integer (got ${JSON.stringify(r[key])})`);
    }
    if (errors.some(e => e.startsWith(at))) return;

    if (r.physical_end < r.physical_start) {
      errors.push(`${at}: physical_end ${r.physical_end} is before physical_start ${r.physical_start}`);
      return;
    }
    if (declaredPageCount != null && r.physical_end > declaredPageCount) {
      errors.push(`${at}: physical_end ${r.physical_end} exceeds the document's ${declaredPageCount} pages`);
    }
    // Overlapping ranges would make one physical page resolve to two printed
    // numbers, so the mapping would no longer be a function.
    for (const prev of seen) {
      if (r.physical_start <= prev.physical_end && prev.physical_start <= r.physical_end) {
        errors.push(`${at}: physical range ${r.physical_start}-${r.physical_end} overlaps ${prev.physical_start}-${prev.physical_end}`);
      }
    }
    seen.push(r);
  });

  return errors;
}

/**
 * Physical PDF page -> printed page, or null when unmapped.
 * @param {number} physicalPage
 * @param {Array|null|undefined} ranges  curated printed_page_ranges
 */
export function printedPageFor(physicalPage, ranges) {
  if (!Array.isArray(ranges) || !Number.isInteger(physicalPage)) return null;
  for (const r of ranges) {
    if (!r || !Number.isInteger(r.physical_start) || !Number.isInteger(r.physical_end)
        || !Number.isInteger(r.printed_start)) continue;
    if (physicalPage >= r.physical_start && physicalPage <= r.physical_end) {
      return r.printed_start + (physicalPage - r.physical_start);
    }
  }
  return null;
}

/**
 * Judge-facing page label. Printed page when one is configured, physical otherwise,
 * so unmapped documents keep exactly the wording they have today.
 */
export function pageLabel(physicalPage, printedPage) {
  return printedPage != null ? `printed page ${printedPage}` : `page ${physicalPage}`;
}
