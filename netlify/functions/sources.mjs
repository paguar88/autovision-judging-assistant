/** Approved document list - v1.0 §16.1. Curated metadata only. */
import { requireSession } from '../../src/services/session.mjs';
import { sourceDocuments } from '../../src/services/corpus.mjs';

export default async (request) => {
  if (!requireSession(request)) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ documents: sourceDocuments('ferrari') }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' },
  });
};
