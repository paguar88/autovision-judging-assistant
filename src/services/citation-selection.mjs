/**
 * Citation selection - judge-facing presentation only.
 *
 * Retrieval may legitimately return broad context. This decides which VERIFIED pages
 * are shown, so the judge is not handed every retrieved chunk to sort through.
 *
 * DETERMINISM. The selected set is anchored to things that do not vary between
 * identical requests: the judge's question, the frozen corpus, and the source text of
 * the candidate pages. Generated answer prose is used for one narrow purpose only -
 * deciding whether a supplementary page's distinct facts are actually being relied on -
 * and even there only distinctive terms count, because a paraphrase preserves the
 * substantive nouns and codes while varying everything around them. Model relevance
 * scores are never used, not even as a tie-break, since they drift run to run.
 *
 * What it does NOT do:
 *  - it does not verify pages (the frozen resolver already did that, upstream);
 *  - it does not rank-truncate to a top N;
 *  - it does not let the model name a document or a page;
 *  - it never runs on a CONFLICT, so a real disagreement is never pruned away.
 */

const STOP = new Set(('the a an and or of on in for to is are was were be been being with without from into over under this that these those it its they them their there here as at by but not no nor if then than when where which who whom whose what how why all any both each few more most other some such only own same so too very can will just should now have has had do does did shall may might must about above below between through during before after again further once you your yours we our ours i me my mine he she his her hers correct incorrect original originally car cars page pages document documents judge judging judged item items should would could appear appears shown show yes also still seen used use'.split(' ')));

const normalize = (s) => String(s || '')
  .toLowerCase()
  .replace(/[\u2018\u2019]/g, "'")
  .replace(/[^a-z0-9/\-.#\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function tokens(text) {
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

/* ---- corpus salience, computed once from the frozen corpus ---- */
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
function salience(corpusTexts) {
  const { n, df } = documentFrequency(corpusTexts);
  const ceiling = Math.max(3, Math.round(n * 0.15));
  return {
    isSalient: (t) => /\d/.test(t) || (df.get(t) ?? 0) <= ceiling,
    weight: (t) => Math.log(n / Math.max(1, df.get(t) ?? 1)),
  };
}

const salientSet = (text, sal) => new Set(tokens(text).filter(sal.isSalient));

/** Hyphens are dropped on both sides before comparing. The corpus is inconsistent
 *  about compound terms - the checklist writes "knock-off", the As-Built notes write
 *  "knockoff" - and treating those as different words made a page look unrelated to
 *  the very subject it documents. */
const squash = (s) => normalize(s).replace(/-/g, '');
const present = (term, text) => squash(text).includes(squash(term));

/** A page that explicitly announces a judging category, or null when it declares none.
 *  Only an explicit declaration counts - absence never triggers exclusion. */
export function declaredCategory(pageText) {
  const m = normalize(pageText).match(/\b(exterior|interior|engine\s*(?:&|and)?\s*chassis)\b\s*,?\s*items to be observed/);
  if (!m) return null;
  return m[1].startsWith('engine') ? 'Engine and Chassis' : (m[1] === 'exterior' ? 'Exterior' : 'Interior');
}

/** How many distinct facts a supplementary page must add before it earns a place.
 *  Set above one so a single incidental word ("prancing" for "horse") cannot flip it. */
const NOVEL_MIN = 3;

/**
 * @param {object[]} citations   verified citations, each carrying `primary_text`
 * @param {string} question      the judge's question - the stable anchor
 * @param {string} answerText    generated prose, used only to gate supplementary pages
 * @param {string[]} corpusTexts every page of the frozen corpus, for salience
 * @param {string|null} category active judging category
 * @param {string} status
 */
export function selectCitations({ citations, question, answerText, corpusTexts, category, status }) {
  const verified = citations.filter(c => c.page_verified);

  // A disagreement between approved sources must always be shown in full.
  if (status === 'CONFLICT') {
    return { displayed: verified, suppressed: [], reason: 'conflict: all sources retained' };
  }
  if (verified.length <= 1) {
    return { displayed: verified, suppressed: [], reason: 'nothing to select from' };
  }

  const texts = corpusTexts && corpusTexts.length ? corpusTexts : verified.map(c => c.primary_text);
  const sal = salience(texts);

  // Subject comes from the question, which is identical across repeated runs. Only if
  // the question carries no distinctive term at all do we fall back to the answer.
  let subject = salientSet(question, sal);
  if (subject.size === 0) subject = salientSet(answerText, sal);
  if (subject.size === 0) {
    return { displayed: verified, suppressed: [], reason: 'no distinctive subject terms to match on' };
  }

  // Category gate: drop a page that explicitly announces a different category.
  const eligible = verified.filter(c => {
    const declared = declaredCategory(c.primary_text);
    return !(category && declared && declared !== category);
  });
  const pool = eligible.length ? eligible : verified;

  // Primary: the page whose own text most strongly covers the question's subject.
  // Ties break on stable properties only - never on a model score.
  const scored = pool.map(c => {
    let weight = 0, hits = 0;
    for (const t of subject) if (present(t, c.primary_text)) { weight += sal.weight(t); hits++; }
    return { citation: c, weight, hits };
  }).sort((a, b) =>
    b.weight - a.weight ||
    b.hits - a.hits ||
    a.citation.document_id.localeCompare(b.citation.document_id) ||
    a.citation.page_number - b.citation.page_number);

  const primary = scored[0];

  // Supplementary: a page joins only when it carries distinctive facts the primary
  // page lacks AND the answer actually relies on them, with a margin.
  const answerTerms = salientSet(answerText, sal);
  const chosen = [primary.citation];
  const contributions = [];

  for (const s of scored.slice(1)) {
    if (s.hits === 0) continue;                        // not about the subject at all
    const novel = [...answerTerms].filter(t =>
      present(t, s.citation.primary_text) && !present(t, primary.citation.primary_text));
    if (novel.length >= NOVEL_MIN) {
      chosen.push(s.citation);
      contributions.push(`${s.citation.document_id} p${s.citation.page_number}: ${novel.slice(0, 5).join(', ')}`);
    }
  }

  const keep = new Set(chosen.map(c => c.unit_id));
  const displayed = [primary.citation, ...verified.filter(c => keep.has(c.unit_id) && c.unit_id !== primary.citation.unit_id)];

  return {
    displayed,
    suppressed: verified.filter(c => !keep.has(c.unit_id)),
    reason: contributions.length
      ? `primary source plus ${contributions.length} page(s) adding distinct evidence`
      : 'single source states the requested specification',
  };
}
