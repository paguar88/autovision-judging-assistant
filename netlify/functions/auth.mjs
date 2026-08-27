/** Beta authentication - v1.0 §6. Shared password, server-side verification. */
import { verifyPassword, issueSession, readSession, clearSession } from '../../src/services/session.mjs';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default async (request) => {
  if (request.method === 'GET') {
    return json({ authenticated: readSession(request).valid });
  }
  if (request.method === 'DELETE') {
    return json({ authenticated: false }, 200, { 'Set-Cookie': clearSession() });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let password;
  try { ({ password } = await request.json()); } catch { return json({ error: 'Invalid request' }, 400); }

  if (!process.env.BETA_PASSWORD) {
    return json({ error: 'The application is not fully configured. Contact Autovision Studios.' }, 503);
  }
  if (!verifyPassword(password)) {
    // Simple message; reveals nothing about the implementation (v1.0 §6, §26).
    return json({ error: 'Incorrect password.' }, 401);
  }
  return json({ authenticated: true }, 200, { 'Set-Cookie': issueSession() });
};
