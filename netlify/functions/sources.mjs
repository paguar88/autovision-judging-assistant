/** Approved document list - v1.0 §16.1. Curated metadata only. */
import { requireSession } from '../../src/services/session.mjs';
import { sourceDocuments, supportedModels } from '../../src/services/corpus.mjs';

export default async (request) => {
  if (!requireSession(request)) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  // The judge-selectable model list rides on the existing authenticated endpoint
  // rather than a second one: it is derived from the same corpus, and a separate
  // route would be a second place for the two to drift apart.
  return new Response(JSON.stringify({
    documents: sourceDocuments('ferrari'),
    models: supportedModels('ferrari'),
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
  });
};
