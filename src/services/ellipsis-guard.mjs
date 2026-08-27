/**
 * Standalone question integrity - Addendum A.12.
 *
 * Runs BEFORE retrieval, deterministically, with no model call. Its only job is to
 * decide whether a question names enough of its own subject to stand alone when
 * combined with structured context (brand, year, model, class, category).
 *
 * It does not attempt to understand judging content. It favours false-positive
 * rejection over silent semantic drift.
 *
 * This is a guardrail, not a guarantee. It reliably catches pronoun-only subjects.
 * It will not catch every elliptical construction - "and the rear ones on the
 * driver's side" contains no pronoun and will pass. It reduces the failure mode;
 * it does not close it.
 */

const NUDGE = 'Please name the component you\'re asking about so the question can be checked accurately.';

// Openers that carry no subject of their own.
const ELLIPTICAL_OPENERS = [
  /^\s*(?:and|but|so|then|also)\b/i,
  /^\s*what\s+about\b/i,
  /^\s*how\s+about\b/i,
  /^\s*(?:and\s+)?the\s+(?:other|rear|front|left|right|second|next)\s+(?:one|ones)\b/i,
];

// Whole questions that are nothing but a deictic reference.
const DEICTIC_ONLY = [
  /^\s*(?:is|are|was|were)\s+(?:that|this|those|these|it|they)\b[^?]{0,40}\??\s*$/i,
  /^\s*(?:what|which)\s+(?:about\s+)?(?:that|this|those|these|it|them)\b[^?]{0,40}\??\s*$/i,
  /^\s*(?:that|this|those|these|it|they)\s+(?:one|ones)?\s*\??\s*$/i,
];

// A subject-bearing noun anywhere in the question is enough to clear the guard.
const PRONOUNS = /\b(?:it|its|they|them|their|that|this|those|these|one|ones|same|other|another)\b/gi;
const FILLER = new Set(('is are was were the a an of on in for to and or if do does did should would could can be been being correct right wrong ok okay what which how about why when where too also still yet more less than as at by with without from into over under').split(' '));

/**
 * @returns {{ok:true} | {ok:false, message:string, code:string}}
 */
export function checkStandalone(question) {
  const q = String(question || '').trim();

  if (q.length < 3) return { ok: false, code: 'TOO_SHORT', message: 'Please type a question.' };
  if (q.length > 600) return { ok: false, code: 'TOO_LONG', message: 'Please shorten the question to under 600 characters.' };

  for (const re of DEICTIC_ONLY) {
    if (re.test(q)) return { ok: false, code: 'DEICTIC_ONLY', message: NUDGE };
  }
  for (const re of ELLIPTICAL_OPENERS) {
    if (re.test(q)) return { ok: false, code: 'ELLIPTICAL_OPENER', message: NUDGE };
  }

  // Strip pronouns and filler; what remains should still name something.
  const remaining = q
    .toLowerCase()
    .replace(/[^a-z0-9\/\s-]/g, ' ')
    .replace(PRONOUNS, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !FILLER.has(w));

  if (remaining.length === 0) {
    return { ok: false, code: 'NO_SUBJECT', message: NUDGE };
  }
  return { ok: true };
}
