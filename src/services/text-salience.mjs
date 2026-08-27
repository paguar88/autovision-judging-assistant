/**
 * Term salience over the frozen corpus.
 *
 * Shared by citation selection and answer presentation. Both need the same judgement:
 * which words in a piece of text actually carry information, as opposed to being
 * common judging vocabulary that appears on half the pages in the corpus.
 *
 * Extracted so the two callers cannot drift apart.
 */

const STOP = new Set(('the a an and or of on in for to is are was were be been being with without from into over under this that these those it its they them their there here as at by but not no nor if then than when where which who whom whose what how why all any both each few more most other some such only own same so too very can will just should now have has had do does did shall may might must about above below between through during before after again further once you your yours we our ours i me my mine he she his her hers correct incorrect original originally car cars page pages document documents judge judging judged item items should would could appear appears shown show yes also still seen used use'.split(' ')));

export const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[^a-z0-9/\-.#\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function tokens(text) {
  const out = [];
  for (const raw of normalize(text).split(' ')) {
    const w = raw.replace(/^[-./#]+|[-./]+$/g, '');
    if (!w) continue;
    if (/\d/.test(w)) { if (w.length >= 2) out.push(w); continue; }
    if (w.length < 4 || STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

/** Hyphens are dropped on both sides before comparing. The corpus is inconsistent
 *  about compound terms - the checklist writes "knock-off", the As-Built notes write
 *  "knockoff" - and treating those as different words made a page look unrelated to
 *  the very subject it documents. */
export const squash = (s) => normalize(s).replace(/-/g, '');
export const present = (term, text) => squash(text).includes(squash(term));

let dfCache = null;
function documentFrequency(corpusTexts) {
  if (dfCache && dfCache.n === corpusTexts.length) return dfCache;
  const df = new Map();
  for (const t of corpusTexts) {
    for (const w of new Set(tokens(t))) df.set(w, (df.get(w) || 0) + 1);
  }
  dfCache = { n: corpusTexts.length, df };
  return dfCache;
}

/** A term is distinctive when it is rare across the corpus, or carries a number.
 *  Common judging vocabulary ("chrome", "black", "wheel") is not evidence of anything. */
export function salience(corpusTexts) {
  const { n, df } = documentFrequency(corpusTexts);
  const ceiling = Math.max(3, Math.round(n * 0.15));
  return {
    isSalient: (t) => /\d/.test(t) || (df.get(t) ?? 0) <= ceiling,
    weight: (t) => Math.log(n / Math.max(1, df.get(t) ?? 1)),
  };
}

export const salientSet = (text, sal) => new Set(tokens(text).filter(sal.isSalient));
