/**
 * Protected source delivery - Addendum A.7.
 *
 * Session-authenticated, function-proxied. The client never supplies a filesystem
 * path; it supplies a document_id that must resolve through the approved manifest.
 * The page parameter controls navigation only and cannot change what is authorized.
 *
 * Viewing a source is NOT an AI operation: no OpenAI call, no file_search, no
 * regeneration of the answer.
 */
import { readFileSync } from 'node:fs';
import { requireSession } from '../../src/services/session.mjs';
import { corpus } from '../../src/services/corpus.mjs';

const err = (msg, status) => new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json' } });

export default async (request) => {
  if (!requireSession(request)) return err('Not authenticated', 401);

  const url = new URL(request.url);
  const documentId = url.searchParams.get('document_id');
  const pageParam = url.searchParams.get('page');

  const c = corpus('ferrari');
  const doc = c.docById.get(documentId);
  if (!doc || !doc.active || doc.redistribution_status !== 'approved') {
    return err('Unknown or inactive source document.', 404);
  }

  const page = pageParam ? parseInt(pageParam, 10) : 1;
  if (!Number.isInteger(page) || page < 1 || page > doc.page_count) {
    return err(`Page out of range. This document has ${doc.page_count} page(s).`, 404);
  }

  if (url.searchParams.get('meta') === '1') {
    return new Response(JSON.stringify({
      document_id: doc.document_id, display_title: doc.display_title,
      document_version: doc.document_version, page_count: doc.page_count, page,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const bytes = readFileSync(c.slicePath(doc.document_id, page));
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${doc.document_id}-p${page}.pdf"`,
        'Cache-Control': 'private, max-age=600',
        'X-Source-Page': String(page),
        'X-Source-Page-Count': String(doc.page_count),
      },
    });
  } catch {
    return err('The source document page could not be opened.', 500);
  }
};
