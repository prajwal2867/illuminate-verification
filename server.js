import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';

const rootDirectory = fileURLToPath(new URL('.', import.meta.url));
const dataDirectory = join(rootDirectory, 'data');
const databasePath = join(dataDirectory, 'event-verification.db');
const port = Number(process.env.PORT || 3000);
const eventId = 'illuminate-2026';
const maxBodyBytes = 12_000;
const registrationWindowMs = 60_000;
const registrationAttempts = new Map();
const sessions = new Map();
const PREDEFINED_ADMIN_ACCOUNTS = [
  { email: 'test@example.com', password: '28672867', name: 'Test Admin' }
  // Add the remaining authorized admin accounts here when they are provided.
];
const encryptionKey = createHash('sha256')
  .update(process.env.PASS_ENCRYPTION_KEY || 'local-development-pass-encryption-key')
  .digest();

if (!existsSync(dataDirectory)) {
  mkdirSync(dataDirectory, { recursive: true });
}

const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    starts_at TEXT,
    ends_at TEXT,
    status TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE IF NOT EXISTS registrations (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    illuminate_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS registrations_event_illuminate_id
    ON registrations(event_id, illuminate_id);
  CREATE TABLE IF NOT EXISTS passes (
    id TEXT PRIMARY KEY,
    registration_id TEXT NOT NULL UNIQUE REFERENCES registrations(id),
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    issued_at TEXT NOT NULL,
    expires_at TEXT,
    qr_payload_encrypted TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

try {
  database.exec('ALTER TABLE passes ADD COLUMN qr_payload_encrypted TEXT');
} catch {
  // Existing databases already have the column.
}

database.prepare(`
  INSERT INTO events (id, name, starts_at, status)
  VALUES (?, ?, ?, 'open')
  ON CONFLICT(id) DO NOTHING
`).run(eventId, 'Illuminate Verification', '2026-12-31T18:00:00.000Z');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function getLocalOrigin(request) {
  const origin = request.headers.origin || '';
  return /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? origin : 'http://localhost:5500';
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': response.localOrigin || 'http://localhost:5500',
    'Access-Control-Allow-Credentials': 'true'
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function getCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const [name, ...value] = part.trim().split('=');
    return [name, decodeURIComponent(value.join('='))];
  }));
}

function getAdminSession(request) {
  const sessionId = getCookies(request).admin_session;
  if (!sessionId) {
    return null;
  }
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function requireAdmin(request, response) {
  const session = getAdminSession(request);
  if (!session) {
    sendError(response, 401, 'Admin authentication is required.');
    return null;
  }
  return session;
}

function encryptPayload(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function decryptPayload(value) {
  const packed = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}

function setSessionCookie(response, sessionId) {
  response.setHeader('Set-Cookie', `admin_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function clearSessionCookie(response) {
  response.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

function normalizeRegistration(input) {
  return {
    name: String(input.name || '').trim().replace(/\s+/g, ' '),
    email: String(input.email || '').trim().toLowerCase(),
    phone: String(input.phone || '').trim(),
    illuminateId: String(input.illuminateId || '').trim().toUpperCase()
  };
}

function isValidRegistration(registration) {
  return registration.name.length >= 2 && registration.name.length <= 120
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registration.email)
    && registration.email.length <= 254
    && registration.phone.replace(/\D/g, '').length >= 10
    && registration.phone.length <= 30
    && /^[A-Z0-9-]{3,40}$/.test(registration.illuminateId);
}

function getClientKey(request) {
  return request.socket.remoteAddress || 'unknown';
}

function isRateLimited(request) {
  const now = Date.now();
  const key = getClientKey(request);
  const attempts = (registrationAttempts.get(key) || []).filter((time) => now - time < registrationWindowMs);
  attempts.push(now);
  registrationAttempts.set(key, attempts);
  return attempts.length > 5;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBodyBytes) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function handleRegistration(request, response) {
  if (isRateLimited(request)) {
    sendError(response, 429, 'Too many attempts. Please try again shortly.');
    return;
  }

  let input;
  try {
    input = JSON.parse(await readRequestBody(request));
  } catch {
    sendError(response, 400, 'Invalid request.');
    return;
  }

  const registration = normalizeRegistration(input);
  if (!isValidRegistration(registration)) {
    sendError(response, 400, 'Please check the registration details and try again.');
    return;
  }

  const event = database.prepare('SELECT id, name FROM events WHERE id = ? AND status = \'open\'').get(eventId);
  if (!event) {
    sendError(response, 409, 'Registration is currently closed.');
    return;
  }

  const existing = database.prepare(
    'SELECT id FROM registrations WHERE event_id = ? AND illuminate_id = ?'
  ).get(eventId, registration.illuminateId);
  if (existing) {
    sendError(response, 409, 'This Illuminate ID has already been registered.');
    return;
  }

  const registrationId = randomUUID();
  const passId = `PASS-${randomBytes(4).toString('hex').toUpperCase()}`;
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const createdAt = new Date().toISOString();
  const qrPayload = `EVP1.${eventId}.${rawToken}`;

  try {
    database.exec('BEGIN');
    database.prepare(`
      INSERT INTO registrations (id, event_id, name, email, phone, illuminate_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(registrationId, eventId, registration.name, registration.email, registration.phone, registration.illuminateId, createdAt);
    database.prepare(`
      INSERT INTO passes (id, registration_id, token_hash, issued_at, qr_payload_encrypted)
      VALUES (?, ?, ?, ?, ?)
    `).run(passId, registrationId, tokenHash, createdAt, encryptPayload(qrPayload));
    database.prepare(`
      INSERT INTO audit_logs (id, action, entity_id, created_at)
      VALUES (?, 'registration_created', ?, ?)
    `).run(randomUUID(), registrationId, createdAt);
    database.exec('COMMIT');
  } catch {
    database.exec('ROLLBACK');
    sendError(response, 500, 'Registration could not be completed.');
    return;
  }

  const qrDataUrl = await QRCode.toDataURL(qrPayload, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
  sendJson(response, 201, { name: registration.name, illuminateId: registration.illuminateId, passId, qrDataUrl });
}

async function handleAdminLogin(request, response) {
  let input;
  try {
    input = JSON.parse(await readRequestBody(request));
  } catch {
    sendError(response, 400, 'Invalid login request.');
    return;
  }
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const account = PREDEFINED_ADMIN_ACCOUNTS.find((item) => item.email.toLowerCase() === email);
  const submittedPasswordHash = createHash('sha256').update(password).digest();
  const configuredPasswordHash = createHash('sha256')
    .update(account?.password || randomBytes(32).toString('hex'))
    .digest();
  const passwordMatch = timingSafeEqual(submittedPasswordHash, configuredPasswordHash);
  if (!account || !passwordMatch) {
    sendError(response, 401, 'Those admin credentials are not recognized.');
    return;
  }
  const sessionId = randomBytes(32).toString('base64url');
  sessions.set(sessionId, { name: account.name, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  setSessionCookie(response, sessionId);
  sendJson(response, 200, { name: account.name });
}

function handleAdminLogout(request, response) {
  const sessionId = getCookies(request).admin_session;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  clearSessionCookie(response);
  sendJson(response, 200, { ok: true });
}

async function handleAdminRegistrations(request, response) {
  if (!requireAdmin(request, response)) {
    return;
  }
  const rows = database.prepare(`
    SELECT r.id, r.name, r.email, r.phone, r.illuminate_id AS illuminateId,
      r.status, r.created_at AS createdAt, p.id AS passId, p.status AS passStatus,
      p.qr_payload_encrypted AS encryptedQr
    FROM registrations r
    JOIN passes p ON p.registration_id = r.id
    WHERE r.event_id = ? AND r.status != 'removed'
    ORDER BY r.created_at DESC
  `).all(eventId).map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    illuminateId: row.illuminateId,
    status: row.status,
    createdAt: row.createdAt,
    passId: row.passId,
    passStatus: row.passStatus,
    encryptedQr: row.encryptedQr
  }));
  const registrations = await Promise.all(rows.map(async (row) => ({
    ...row,
    qrDataUrl: row.encryptedQr
      ? await QRCode.toDataURL(decryptPayload(row.encryptedQr), { errorCorrectionLevel: 'M', margin: 2, width: 220 })
      : null
  })));
  registrations.forEach((row) => delete row.encryptedQr);
  sendJson(response, 200, { registrations });
}

async function handleRemoveRegistration(request, response, registrationId) {
  if (!requireAdmin(request, response)) {
    return;
  }
  let input = {};
  try {
    input = JSON.parse(await readRequestBody(request));
  } catch {
    sendError(response, 400, 'Invalid removal request.');
    return;
  }
  const reason = String(input.reason || '').trim();
  if (reason.length < 3 || reason.length > 250) {
    sendError(response, 400, 'A removal reason is required.');
    return;
  }
  const registration = database.prepare('SELECT id FROM registrations WHERE id = ? AND event_id = ? AND status != \'removed\'').get(registrationId, eventId);
  if (!registration) {
    sendError(response, 404, 'Registration not found.');
    return;
  }
  const now = new Date().toISOString();
  database.exec('BEGIN');
  try {
    database.prepare('UPDATE registrations SET status = \'removed\' WHERE id = ?').run(registrationId);
    database.prepare('UPDATE passes SET status = \'revoked\' WHERE registration_id = ?').run(registrationId);
    database.prepare('INSERT INTO audit_logs (id, action, entity_id, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), `registration_removed: ${reason}`, registrationId, now);
    database.exec('COMMIT');
  } catch {
    database.exec('ROLLBACK');
    sendError(response, 500, 'Registration could not be removed.');
    return;
  }
  sendJson(response, 200, { ok: true });
}

async function handleVerifyPass(request, response) {
  if (!requireAdmin(request, response)) {
    return;
  }
  let input;
  try {
    input = JSON.parse(await readRequestBody(request));
  } catch {
    sendError(response, 400, 'Invalid verification request.');
    return;
  }
  const value = String(input.value || '').trim();
  if (!value) {
    sendError(response, 400, 'Enter or scan a pass.');
    return;
  }
  let pass;
  if (value.startsWith('EVP1.')) {
    const token = value.split('.').pop();
    pass = database.prepare(`
      SELECT p.id AS passId, p.status AS passStatus, r.name, r.email, r.phone,
        r.illuminate_id AS illuminateId, r.status
      FROM passes p JOIN registrations r ON r.id = p.registration_id
      WHERE p.token_hash = ? AND r.event_id = ?
    `).get(createHash('sha256').update(token).digest('hex'), eventId);
  } else {
    pass = database.prepare(`
      SELECT p.id AS passId, p.status AS passStatus, r.name, r.email, r.phone,
        r.illuminate_id AS illuminateId, r.status
      FROM passes p JOIN registrations r ON r.id = p.registration_id
      WHERE p.id = ? AND r.event_id = ?
    `).get(value.toUpperCase(), eventId);
  }
  if (!pass) {
    sendJson(response, 404, { result: 'not_found', message: 'Pass not found.' });
    return;
  }
  if (pass.status === 'removed' || pass.passStatus === 'revoked') {
    sendJson(response, 403, { result: 'revoked', message: 'This pass was removed or revoked.', attendee: pass });
    return;
  }
  if (pass.passStatus === 'used') {
    sendJson(response, 409, { result: 'already_used', message: 'This pass has already been used.', attendee: pass });
    return;
  }
  database.prepare('UPDATE passes SET status = \'used\' WHERE id = ?').run(pass.passId);
  database.prepare('INSERT INTO audit_logs (id, action, entity_id, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), 'pass_checked_in', pass.passId, new Date().toISOString());
  sendJson(response, 200, { result: 'accepted', message: 'Pass accepted. Entry recorded.', attendee: pass });
}

function serveStatic(request, response) {
  const requestedPath = request.url === '/' ? '/index.html' : decodeURIComponent(request.url.split('?')[0]);
  const filePath = normalize(join(rootDirectory, requestedPath));
  if (!filePath.startsWith(rootDirectory) || !existsSync(filePath)) {
    sendError(response, 404, 'Not found.');
    return;
  }
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  response.end(readFileSync(filePath));
}

const server = createServer(async (request, response) => {
  response.localOrigin = getLocalOrigin(request);
  const requestPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  if (request.method === 'OPTIONS' && requestPath.startsWith('/api/')) {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': response.localOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    response.end();
    return;
  }
  if (request.method === 'POST' && requestPath === '/api/admin/login') {
    await handleAdminLogin(request, response);
    return;
  }
  if (request.method === 'POST' && requestPath === '/api/admin/logout') {
    handleAdminLogout(request, response);
    return;
  }
  if (request.method === 'GET' && requestPath === '/api/admin/registrations') {
    await handleAdminRegistrations(request, response);
    return;
  }
  if (request.method === 'POST' && requestPath.startsWith('/api/admin/registrations/')) {
    const registrationId = requestPath.split('/')[4];
    await handleRemoveRegistration(request, response, registrationId);
    return;
  }
  if (request.method === 'POST' && requestPath === '/api/admin/verify') {
    await handleVerifyPass(request, response);
    return;
  }
  if (request.method === 'POST' && requestPath === '/api/events/illuminate-2026/registrations') {
    await handleRegistration(request, response);
    return;
  }
  if (request.method === 'GET') {
    serveStatic(request, response);
    return;
  }
  sendError(response, 405, 'Method not allowed.');
});

server.listen(port, () => {
  console.log(`Event verification system running at http://localhost:${port}`);
});