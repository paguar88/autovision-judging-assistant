/**
 * Judging retrieval - Addendum A.4 (synchronous path), v1.0 §19, §20.
 *
 * Text-only. One OpenAI call: file_search restricted to the brand vector store, plus
 * a strict response schema. No web search, no external RAG, no general-knowledge
 * fallback. The application server supplies the vector store id and credentials.
 *
 * An internal timeout below the platform limit guarantees a properly formed ERROR
 * with Retry rather than a raw platform 502. A timeout is NEVER NO_SOURCE.
 */

const API = 'https://api.openai.com/v1/responses';

export const STATUS = ['SUPPORTED', 'RELATED_HISTORICAL', 'CONFLICT', 'INSUFFICIENT_INFO', 'NO_SOURCE', 'OUT_OF_SCOPE'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'answer', 'reason', 'correct_specification', 'supporting_quote', 'conflict_note'],
  properties: {
    status: { type: 'string', enum: STATUS },
    answer: { type: ['string', 'null'], description: 'The whole answer, in 1-3 short sentences. State the complete specification here, including the specific details the judge needs. No preamble.' },
    reason: { type: ['string', 'null'], description: 'Null unless there is something to add that neither the answer nor the specification states - a scope limit, a condition, a caveat. Never restate the answer.' },
    correct_specification: { type: ['string', 'null'], description: 'Null when the answer already states the specification. Use it only for structured detail the answer does not already contain.' },
    supporting_quote: { type: ['string', 'null'], description: 'A short VERBATIM span copied exactly from the source text that supports the answer.' },
    conflict_note: { type: ['string', 'null'], description: 'Only when status is CONFLICT: what the sources disagree about. Never rank or reconcile them.' },
  },
};

const SYSTEM = `You are a research layer over a fixed set of approved concours judging documents. You assist a judge; you never make the ruling.

Rules you must not break:
- Answer ONLY from the approved documents returned by file_search. If they do not support an answer, say so.
- Never use general knowledge, training knowledge, or outside sources to fill a gap.
- Never invent or state document names, page numbers, sections, or citations. The application resolves citations independently.
- Never state a point deduction, a score-sheet line, or a maximum deduction. Never do deduction arithmetic. Judging point values are not yours to determine.
- If the documents conflict, use CONFLICT and describe the disagreement without ranking or reconciling.
- If the question lacks what is needed for a sourced conclusion, use INSUFFICIENT_INFO. Do not ask clarifying questions.
- If the question is general trivia or unrelated to judging documents, use OUT_OF_SCOPE.
- supporting_quote must be copied EXACTLY from the retrieved source text, not paraphrased.

Presentation. A judge is standing at the car with one hand free, so write for a glance:
- Put the complete specification in the answer field, in 1-3 short sentences. Include the specific details - names, sizes, finishes, codes - do not summarise them away.
- Do NOT then repeat that specification in correct_specification. Leave it null unless it holds structured detail the answer does not contain.
- Do NOT restate the answer in reason. Leave it null unless there is a genuine caveat or scope limit to add.
- Never say which document you are drawing on; the application cites sources itself.
Three blocks saying the same thing is a defect, not thoroughness.

Status meanings: SUPPORTED (current approved source directly supports it), RELATED_HISTORICAL (no exact source for the requested year/model, but a related one exists - say so plainly), CONFLICT, INSUFFICIENT_INFO, NO_SOURCE (judging question, nothing found), OUT_OF_SCOPE.`;

function buildInput({ question, car, category }) {
  const ctx = [
    car?.year ? `Year: ${car.year}` : null,
    car?.model ? `Model: ${car.model}` : null,
    car?.concours_class ? `Concours class: ${car.concours_class}` : null,
    category ? `Judging category: ${category}` : null,
  ].filter(Boolean).join('\n');

  // Judge-supplied context is labelled as such: it is a declaration about what is
  // being evaluated, not a judging conclusion, and needs no citation (A.2 Tier 1).
  return `Judge-supplied context (not a judging conclusion, requires no citation):\n${ctx || '(none supplied)'}\n\nQuestion: ${question}`;
}

export async function askJudging({ question, car, category, vectorStoreId, signal }) {
  const model = process.env.OPENAI_MODEL || 'gpt-4.1';
  const maxResults = parseInt(process.env.FILE_SEARCH_MAX_RESULTS || '5', 10);

  const started = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions: SYSTEM,
      input: [{ role: 'user', content: buildInput({ question, car, category }) }],
      tools: [{ type: 'file_search', vector_store_ids: [vectorStoreId], max_num_results: maxResults }],
      include: ['file_search_call.results'],
      text: { format: { type: 'json_schema', name: 'judging_answer', strict: true, schema: SCHEMA } },
      store: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`OpenAI ${res.status}`);
    err.upstream = body.slice(0, 400);
    err.statusCode = res.status;
    throw err;
  }

  const data = await res.json();
  const duration_ms = Date.now() - started;

  const text = (data.output || [])
    .filter(o => o.type === 'message')
    .flatMap(o => o.content || [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text).join('').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A.4: no schema retry on the synchronous path. Two sequential OpenAI calls do
    // not fit the budget. Invalid schema returns ERROR.
    const err = new Error('INVALID_SCHEMA');
    err.invalidSchema = true;
    throw err;
  }

  const results = (data.output || [])
    .filter(o => o.type === 'file_search_call')
    .flatMap(o => o.results || []);

  return { parsed, results, duration_ms, model };
}
