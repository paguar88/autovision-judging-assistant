/**
 * Answer presentation - Stage 2.
 *
 * A judge is standing at a car with one hand free. Three blocks restating the same
 * specification cost reading time and push the citation below the fold.
 *
 * The model is instructed to put the complete specification in the answer and leave the
 * other fields null when they would restate it. This is the deterministic server-side
 * enforcement, so presentation does not depend on the model complying.
 *
 * WHAT COUNTS AS A FACT. A block earns its space by introducing distinctive terms that
 * are (a) absent from the text above it, and (b) actually present in the cited source
 * pages. Grounding novelty in the sources is what separates a real fact from prose glue:
 * "specifies", "along", "details" and "styles" appear in no source page, so restating
 * the answer in different words no longer looks like new information.
 *
 * Words drawn from the approved document TITLES are excluded too. A sentence like "the
 * checklist specifies this configuration" borrows "Configuration" and "Authenticity"
 * from a document title, not from any specification.
 *
 * Nothing here touches status, source selection, page verification, conflict handling,
 * or the three-tier authority model. It only decides whether an already-approved block
 * is worth the space.
 */

import { salience, salientSet, present } from './text-salience.mjs';

/** A block is suppressed only when it adds NOTHING - zero source-grounded facts beyond
 *  the answer and the judge's own question. The strictest safe setting: shortening can
 *  never cost a fact. */
const MIN_NEW_FACTS = 1;

/**
 * @param {string|null} answer
 * @param {string} question       the judge's own wording
 * @param {string|null} correctSpecification
 * @param {string|null} reason
 * @param {string[]} sourceTexts  primary text of the pages actually cited
 * @param {string[]} titles       approved document display titles
 * @param {string[]} corpusTexts  frozen corpus, for term salience
 */
export function pruneRedundantFields({ answer, question = '', correctSpecification, reason, sourceTexts = [], titles = [], corpusTexts = [] }) {
  const suppressed = [];
  const texts = corpusTexts.length ? corpusTexts : [answer, correctSpecification, reason].filter(Boolean);
  const sal = salience(texts);

  const sourceBlob = sourceTexts.join('\n');
  const titleBlob = titles.join(' ');

  /** Terms in `candidate` that are absent above, present in the cited sources, and
   *  not merely borrowed from a document title. */
  const newFacts = (candidate, covered) =>
    [...salientSet(candidate, sal)].filter(t =>
      !present(t, covered) &&
      (sourceBlob ? present(t, sourceBlob) : true) &&
      !(titleBlob && present(t, titleBlob)));

  // The judge's own wording is not new information to the judge: a block repeating
  // terms from the question has told them nothing they did not already type.
  const known = [answer, question].filter(Boolean).join(' ');

  let spec = correctSpecification;
  if (spec && answer && newFacts(spec, known).length < MIN_NEW_FACTS) {
    spec = null;
    suppressed.push('correct_specification');
  }

  // The explanation is measured against everything the judge has already read.
  let why = reason;
  if (why) {
    const above = [answer, question, spec].filter(Boolean).join(' ');
    if (above && newFacts(why, above).length < MIN_NEW_FACTS) {
      why = null;
      suppressed.push('reason');
    }
  }

  return { correct_specification: spec, reason: why, suppressed };
}
