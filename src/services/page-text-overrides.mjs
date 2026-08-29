/**
 * Page text overrides - Citation Repair Slice 3.
 *
 * PDF text extraction reads a page in the order glyphs happen to be stored, not in
 * the order a human reads it. A multi-column table survives that process as
 * interleaved fragments: the 458 wheel-options table extracts with row labels and
 * Modis codes welded to their neighbours, producing strings like "rimSilver" and
 * "RSFD)painted". A retrieval unit built from that text can quote a code beside the
 * wrong wheel while every citation check still passes, because the page really does
 * contain those characters.
 *
 * An override replaces the extracted text of one page with a curator transcription
 * that preserves the visually verified associations.
 *
 * Boundaries, all deliberate:
 *   - This is Tier 2 curator configuration (A.2). Ingestion VALIDATES and APPLIES
 *     it; it never authors or infers one.
 *   - It replaces TEXT ONLY. The page slice delivered to the judge remains an
 *     unaltered copy of the original PDF page (A.7), so the evidence chain still
 *     ends at the original document rather than at a transcription.
 *   - Checksums of both the original and curated text are recorded, so any later
 *     re-extraction that changes the underlying page is detectable.
 */

import { createHash } from 'node:crypto';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Validate a curated page_text_overrides array.
 * @returns {string[]} human-readable problems; empty means valid.
 */
export function validatePageTextOverrides(overrides, { declaredPageCount = null } = {}) {
  const errors = [];
  if (overrides === undefined || overrides === null) return errors;   // absent is legal
  if (!Array.isArray(overrides)) return ['page_text_overrides must be an array'];

  const seen = new Set();

  overrides.forEach((o, i) => {
    const at = `page_text_overrides[${i}]`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) { errors.push(`${at} must be an object`); return; }

    if (!Number.isInteger(o.physical_page) || o.physical_page < 1) {
      errors.push(`${at}.physical_page must be a positive integer (got ${JSON.stringify(o.physical_page)})`);
    } else {
      if (declaredPageCount != null && o.physical_page > declaredPageCount) {
        errors.push(`${at}.physical_page ${o.physical_page} exceeds the document's ${declaredPageCount} pages`);
      }
      // Two overrides for one page would make the applied text depend on array
      // order, so the configuration would no longer have one meaning.
      if (seen.has(o.physical_page)) errors.push(`${at}: physical_page ${o.physical_page} is overridden more than once`);
      seen.add(o.physical_page);
    }

    // A reason is required, not decorative: it is the only record of WHY the
    // extracted text was judged wrong, and the next curator needs it.
    for (const key of ['reason', 'text']) {
      if (typeof o[key] !== 'string' || o[key].trim() === '') {
        errors.push(`${at}.${key} must be a non-blank string`);
      }
    }

    // A transcription is only trustworthy against the exact extraction it was made
    // from. Without this, replacing the PDF - or a pdfjs upgrade that changes
    // extraction - would silently graft old curated text onto a different page.
    if (typeof o.expected_original_text_sha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(o.expected_original_text_sha256)) {
      errors.push(`${at}.expected_original_text_sha256 must be exactly 64 lowercase hexadecimal characters`);
    }
  });

  return errors;
}

/** Curated override for one physical page, or null. */
export function overrideFor(physicalPage, overrides) {
  if (!Array.isArray(overrides) || !Number.isInteger(physicalPage)) return null;
  return overrides.find(o => o && o.physical_page === physicalPage) || null;
}

/**
 * Apply overrides to extracted pages, in place, returning audit records.
 *
 * Must run immediately after extraction and before every downstream step - empty
 * page checks, folio and heading detection, page-map creation, overlap creation,
 * retrieval-unit creation and vocabulary harvesting - so that no stage ever sees
 * the mis-ordered text.
 *
 * @param {Array<{page_number:number, text:string, lines:string[]}>} pages  mutated
 * @param {Array|null} overrides
 * @param {string} documentId
 * @returns {Array<object>} audit records; never contains the override text itself
 */
export function applyPageTextOverrides(pages, overrides, documentId) {
  const audit = [];
  if (!Array.isArray(overrides) || !overrides.length) return audit;

  for (const o of overrides) {
    const page = pages.find(p => p.page_number === o.physical_page);
    if (!page) continue;   // range already rejected by validation

    const originalText = page.text;
    const curated = o.text;
    const actual = sha256(originalText);

    const record = {
      document_id: documentId,
      physical_page: o.physical_page,
      reason: o.reason,
      // The full transcription is deliberately NOT recorded here. The report is a
      // diagnostic artifact, not a second copy of the corpus; checksums are enough
      // to detect drift in either direction.
      expected_original_text_sha256: o.expected_original_text_sha256 ?? null,
      actual_original_text_sha256: actual,
      original_text_sha256: actual,
      curated_text_sha256: sha256(curated),
      original_text_length: originalText.length,
      curated_text_length: curated.length,
      applied: false,
    };

    // Drift check runs BEFORE any mutation. On mismatch the page is left exactly as
    // extracted and the caller blocks: the safe failure is an uncorrected page, not
    // a curated transcription attached to text it was never verified against.
    if (o.expected_original_text_sha256 && actual !== o.expected_original_text_sha256) {
      record.drift = true;
      audit.push(record);
      continue;
    }

    // Both text and lines are replaced: folio and heading detection read lines,
    // everything else reads text, and leaving either as extracted would let the
    // mis-ordered version survive into part of the pipeline.
    page.text = curated;
    page.lines = curated.split('\n');
    page.curator_overridden = true;

    record.applied = true;
    audit.push(record);
  }

  return audit;
}
