/**
 * Judging request - v1.0 §30 Ask processing flow, Addendum A.4, A.9, A.11, A.12.
 *
 * Text-only path. Order matters: every deterministic guard runs before any OpenAI
 * call, so a blocked question costs nothing and counts no usage.
 */

import { requireSession } from '../../src/services/session.mjs';
import { corpus } from '../../src/services/corpus.mjs';
import { checkStandalone } from '../../src/services/ellipsis-guard.mjs';
import { resolveModel, validateYear } from '../../src/services/vehicle-context.mjs';
import { askJudging } from '../../src/services/openai-judging.mjs';
import { verifySources, applyPolicy } from '../../src/services/answer-policy.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const CATEGORIES = ['Exterior', 'Interior', 'Engine and Chassis'];
const CLASSES = ['Regular', 'Preservation'];

export default async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!requireSession(request)) return json({ status: 'ERROR', error: 'Not authenticated' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ status: 'ERROR', error: 'Invalid request' }, 400); }

  const question = String(body.question || '').trim();
  const category = CATEGORIES.includes(body.judging_category) ? body.judging_category : null;
  const car = {
    year: body.car?.year ? String(body.car.year).slice(0, 4) : null,
    model: body.car?.model ? String(body.car.model).slice(0, 60) : null,
    concours_class: CLASSES.includes(body.car?.concours_class) ? body.car.concours_class : null,
  };

  // 1. Judging context must be established. Enforced here, not only by disabling the
  //    input: a disabled control is a convenience and a client can be bypassed.
  const missing = [];
  if (!/^\d{4}$/.test(String(car.year || ''))) missing.push('year');
  if (!car.model) missing.push('model');
  if (!category) missing.push('judging area');
  if (!car.concours_class) missing.push('class');
  if (missing.length) {
    return json({
      status: 'CONTEXT_INCOMPLETE',
      confidence_label: 'Judging context incomplete',
      missing,
      message: `Set the judging context before asking: ${missing.join(', ')}.`,
    }, 400);
  }

  // 2. Standalone-question guard (A.12). No answer card, no OpenAI request, no cost.
  const standalone = checkStandalone(question);
  if (!standalone.ok) {
    return json({ status: 'NEEDS_REPHRASE', code: standalone.code, message: standalone.message });
  }

  const warnings = [];      // judge-facing: things that change how they read the answer
  const diagnostics = [];   // internal: retrieval behaviour, never rendered
  const c = corpus('ferrari');

  // 3. Curated alias normalization before retrieval (A.11).
  let retrievalModel = null;
  if (car.model) {
    const resolved = resolveModel(car.model);
    if (!resolved.resolved) {
      return json({
        status: 'MODEL_NOT_COVERED',
        confidence_label: 'Model not covered',
        message: resolved.message,
        car,
      });
    }
    retrievalModel = resolved.document_designation;
    if (resolved.matched_alias) {
      warnings.push(`"${resolved.matched_alias}" was read as ${resolved.canonical_model_name}.`);
    }
    const yearFlag = validateYear(car.year, resolved);
    if (yearFlag) warnings.push(yearFlag.message);
  }

  const vectorStoreId = c.vectorStoreId();
  if (!vectorStoreId || !process.env.OPENAI_API_KEY) {
    return json({ status: 'ERROR', confidence_label: 'Could not complete the request', error: 'Retrieval is not configured.' }, 503);
  }

  // 4. Internal timeout below the platform limit (A.4). A timeout is ERROR + Retry,
  //    never NO_SOURCE.
  const budget = parseInt(process.env.JUDGING_TIMEOUT_MS || '8500', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);

  try {
    const { parsed, results, duration_ms, model } = await askJudging({
      question,
      car: { ...car, model: retrievalModel || car.model },
      category,
      vectorStoreId,
      signal: controller.signal,
    });

    // 5. Reconcile model output against retrieval metadata and the frozen manifest.
    const { sources, verified, rejected } = verifySources({ results, corpus: c });
    if (rejected.length) diagnostics.push(`${rejected.length} retrieved source(s) could not be reconciled to the approved manifest and were discarded.`);
    if (sources.length && !verified.length) {
      diagnostics.push('No exact page could be verified for these sources.');
    }

    return json(applyPolicy({
      parsed, sources, verified, rejected, duration_ms, model, car, category, warnings, diagnostics,
      question,
      corpusTexts: c.units.map(u => u.primary_text),   // frozen corpus, for term salience
    }));
  } catch (e) {
    const timedOut = e.name === 'AbortError';
    return json({
      status: 'ERROR',
      confidence_label: 'Could not complete the request',
      answer: timedOut
        ? 'The search took too long to complete. Try again.'
        : 'The request could not be completed. Try again.',
      retry: true,
      error_kind: timedOut ? 'TIMEOUT' : (e.invalidSchema ? 'INVALID_SCHEMA' : 'UPSTREAM'),
      instrumentation: { duration_ms: null, path: 'text_only', budget_ms: budget },
    }, 200);
  } finally {
    clearTimeout(timer);
  }
};
