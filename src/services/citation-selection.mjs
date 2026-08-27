/**
 * Citation selection - judge-facing presentation only.
 *
 * Retrieval may legitimately return broad context. This decides which VERIFIED pages
 * are actually shown, so the judge is not handed every retrieved chunk to sort through.
 *
 * What it does NOT do:
 *  - it does not verify pages (the frozen resolver already did that, upstream);
 *  - it does not rank-truncate to a top N;
 *  - it does not let the model name a document or a page;
 *  - it never runs on a CONFLICT, so a real disagreement is never pruned away.
 *
 * Selection is deterministic and evidence-based: a page is shown when the displayed
 * answer's own wording appears on it, and only while it still contributes something
 * the already-selected pages do not.
 */

const STOP = new Set(('the a an and or of on in for to is are was were be been being with without from into over under this that these those it its they them their there here as at by but not no nor if then than when where which who whom whose what how why all any both each few more most other some such only own same so too very can will just should now have has had do does did shall may might must about above below between through during before after again further once you your yours we our ours i me my mine he she his her hers correct incorrect original originally car cars page pages document documents judge judging judged item items should would could appear appears shown show'.split(' ')));

const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[^a-z0-9/\-.\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Content words from the displayed answer. Short filler is dropped; part numbers,
 *  sizes and codes ("14x7", "rw4039", "205") are kept because they are the most
 *  discriminating evidence a specification page can carry. */
export function answerTerms(text) {
  const out = new Set();
  for (const raw of normalize(text).split(' ')) {
    const w = raw.replace(/^[-./]+|[-./]+$/g, '');
    if (!w) continue;
    if (/\d/.test(w) && w.length >= 2) { out.add(w); continue; }
    if (w.length < 4 || STOP.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** Terms from `terms` that appear in the page text. Substring matching handles
 *  plurals and inflections ("spinner" inside "spinners") without stemming. */
function covered(terms, pageText) {
  const hay = normalize(pageText);
  const hit = new Set();
  for (const t of terms) if (hay.includes(t)) hit.add(t);
  return hit;
}

/** A page that explicitly announces a judging category, or null when it declares none.
 *  Only an explicit declaration counts - absence never triggers exclusion. */
export function declaredCategory(pageText) {
  const m = normalize(pageText).match(/\b(exterior|interior|engine\s*(?:&|and)?\s*chassis)\b\s*,?\s*items to be observed/);
  if (!m) return null;
  return m[1].startsWith('engine') ? 'Engine and Chassis' : (m[1] === 'exterior' ? 'Exterior' : 'Interior');
}

const MIN_TERMS = 2;      // a page must carry at least this much of the answer to qualify
const MIN_NEW_TERMS = 2;  // and must still add this much that no selected page covers

/**
 * @param {object[]} citations  verified citations, each carrying `primary_text`
 * @param {string} answerText   the text actually displayed to the judge
 * @param {string|null} quote   the model's verbatim supporting span (verified here, never trusted)
 * @param {string|null} category active judging category
 * @param {string} status
 * @returns {{displayed: object[], suppressed: object[], reason: string}}
 */
export function selectCitations({ citations, answerText, quote, category, status }) {
  const verified = citations.filter(c => c.page_verified);

  // A disagreement between approved sources must always be shown in full.
  if (status === 'CONFLICT') {
    return { displayed: verified, suppressed: [], reason: 'conflict: all sources retained' };
  }
  if (verified.length <= 1) {
    return { displayed: verified, suppressed: [], reason: 'nothing to select from' };
  }

  const terms = answerTerms(answerText);
  if (terms.size === 0) {
    return { displayed: verified, suppressed: [], reason: 'no answer terms to match on' };
  }

  // The model's quote is only ever a hint. It selects nothing unless it appears
  // verbatim on the page, and the page number still comes from the resolver.
  const q = normalize(quote);
  const anchored = new Set(
    q.length > 12 ? verified.filter(c => normalize(c.primary_text).includes(q)).map(c => c.unit_id) : [],
  );

  const scored = verified.map(c => ({
    citation: c,
    covers: covered(terms, c.primary_text),
    declared: declaredCategory(c.primary_text),
    anchored: anchored.has(c.unit_id),
  }));

  // Category gate: drop a page that explicitly announces a different category, unless
  // the answer's own wording is anchored to it.
  const eligible = scored.filter(s => {
    if (s.anchored) return true;
    if (category && s.declared && s.declared !== category) return false;
    return s.covers.size >= MIN_TERMS;
  });

  if (eligible.length === 0) {
    // Never strip a supported answer down to nothing: keep the strongest verified page.
    const best = [...scored].sort((a, b) => b.covers.size - a.covers.size || (b.citation.score ?? 0) - (a.citation.score ?? 0))[0];
    return {
      displayed: [best.citation],
      suppressed: verified.filter(c => c.unit_id !== best.citation.unit_id),
      reason: 'no page met the evidence threshold; strongest verified page retained',
    };
  }

  // Greedy cover: take anchored pages first, then whichever page adds the most that is
  // still uncovered, while it adds enough to earn its place. Two documents that each
  // contribute distinct facts both survive; two pages saying the same thing do not.
  const chosen = [];
  const seen = new Set();
  for (const s of eligible.filter(x => x.anchored)) { chosen.push(s); for (const t of s.covers) seen.add(t); }

  let pool = eligible.filter(s => !chosen.includes(s));
  while (pool.length) {
    let best = null, bestNew = 0;
    for (const s of pool) {
      const fresh = [...s.covers].filter(t => !seen.has(t)).length;
      if (fresh > bestNew || (fresh === bestNew && best && (s.citation.score ?? 0) > (best.citation.score ?? 0))) {
        best = s; bestNew = fresh;
      }
    }
    if (!best || bestNew < (chosen.length === 0 ? 1 : MIN_NEW_TERMS)) break;
    chosen.push(best);
    for (const t of best.covers) seen.add(t);
    pool = pool.filter(s => s !== best);
  }

  const keep = new Set(chosen.map(s => s.citation.unit_id));
  const displayed = verified.filter(c => keep.has(c.unit_id));

  return {
    displayed: displayed.length ? displayed : [eligible[0].citation],
    suppressed: verified.filter(c => !keep.has(c.unit_id)),
    reason: `selected ${displayed.length} of ${verified.length} verified pages by evidentiary contribution`,
  };
}
