import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
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
const loginAttempts = new Map();
const sessionDurationMs = 8 * 60 * 60 * 1000;
const encryptionSecret = process.env.PASS_ENCRYPTION_KEY;
if (!encryptionSecret) {
  throw new Error('PASS_ENCRYPTION_KEY must be configured.');
}
const encryptionKey = createHash('sha256').update(encryptionSecret).digest();

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
    ON registrations(event_id, illuminate_id)
    WHERE status != 'removed';
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
    created_at TEXT NOT NULL,
    actor_admin_id TEXT,
    reason TEXT,
    result TEXT,
    metadata_json TEXT
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    id_hash TEXT PRIMARY KEY,
    admin_user_id TEXT NOT NULL REFERENCES admin_users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS check_ins (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id),
    pass_id TEXT NOT NULL REFERENCES passes(id),
    result TEXT NOT NULL,
    checked_in_at TEXT NOT NULL,
    admin_user_id TEXT REFERENCES admin_users(id),
    UNIQUE(event_id, pass_id)
  );
`);

for (const column of [
  ['audit_logs', 'actor_admin_id TEXT'],
  ['audit_logs', 'reason TEXT'],
  ['audit_logs', 'result TEXT'],
  ['audit_logs', 'metadata_json TEXT'],
  ['passes', 'used_at TEXT']
]) {
  try {
    database.exec(`ALTER TABLE ${column[0]} ADD COLUMN ${column[1]}`);
  } catch {
    // Existing databases already have the column.
  }
}

database.exec('DROP INDEX IF EXISTS registrations_event_illuminate_id');
database.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS registrations_event_illuminate_id
    ON registrations(event_id, illuminate_id)
    WHERE status != 'removed'
`);

try {
  database.exec('ALTER TABLE passes ADD COLUMN qr_payload_encrypted TEXT');
} catch {
  // Existing databases already have the column.
}

function parsePasswordHash(value) {
  const [algorithm, cost, blockSize, parallelization, salt, digest] = String(value || '').split('$');
  if (algorithm !== 'scrypt' || !cost || !blockSize || !parallelization || !salt || !digest) {
    return null;
  }
  return {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelization: Number(parallelization),
    salt,
    digest: Buffer.from(digest, 'base64url')
  };
}

function verifyPassword(password, encodedHash) {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed || !Number.isInteger(parsed.cost) || !Number.isInteger(parsed.blockSize)
    || !Number.isInteger(parsed.parallelization) || parsed.digest.length !== 64) {
    return false;
  }
  const derived = scryptSync(password, parsed.salt, parsed.digest.length, {
    N: parsed.cost,
    r: parsed.blockSize,
    p: parsed.parallelization,
    maxmem: 32 * 1024 * 1024
  });
  return timingSafeEqual(derived, parsed.digest);
}

function hashSessionId(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex');
}

function ensureConfiguredAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const passwordHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (!email || !passwordHash) {
    return;
  }
  const existing = database.prepare('SELECT id FROM admin_users WHERE email = ?').get(email);
  if (existing) {
    database.prepare('UPDATE admin_users SET password_hash = ?, active = 1 WHERE id = ?').run(passwordHash, existing.id);
    return;
  }
  database.prepare(`
    INSERT INTO admin_users (id, email, password_hash, display_name, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), email, passwordHash, process.env.ADMIN_NAME || 'Event Administrator', new Date().toISOString());
}

ensureConfiguredAdmin();

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
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5500')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

function getLocalOrigin(request) {
  const origin = request.headers.origin || '';
  return allowedOrigins.has(origin) ? origin : '';
}

function hasTrustedOrigin(request) {
  const origin = request.headers.origin;
  return !origin || allowedOrigins.has(origin);
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Credentials': 'true',
    ...(response.localOrigin ? {
      'Access-Control-Allow-Origin': response.localOrigin,
      Vary: 'Origin'
    } : {})
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
  const rawSessionId = getCookies(request).admin_session;
  if (!rawSessionId) {
    return null;
  }
  const session = database.prepare(`
    SELECT s.id_hash AS idHash, s.admin_user_id AS adminUserId,
      a.display_name AS name, a.role
    FROM admin_sessions s
    JOIN admin_users a ON a.id = s.admin_user_id
    WHERE s.id_hash = ? AND s.revoked_at IS NULL
      AND s.expires_at > ? AND a.active = 1
  `).get(hashSessionId(rawSessionId), new Date().toISOString());
  if (!session) {
    database.prepare('DELETE FROM admin_sessions WHERE id_hash = ?').run(hashSessionId(rawSessionId));
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
  response.setHeader('Set-Cookie', `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function isRateLimited(map, key, limit, windowMs) {
  const now = Date.now();
  const attempts = (map.get(key) || []).filter((time) => now - time < windowMs);
  attempts.push(now);
  map.set(key, attempts);
  if (map.size > 10_000) {
    for (const [storedKey, storedAttempts] of map) {
      if (!storedAttempts.some((time) => now - time < windowMs)) {
        map.delete(storedKey);
      }
    }
  }
  return attempts.length > limit;
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

function writeAudit(action, entityId, actorAdminId, options = {}) {
  database.prepare(`
    INSERT INTO audit_logs (id, action, entity_id, created_at, actor_admin_id, reason, result, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    action,
    entityId,
    new Date().toISOString(),
    actorAdminId || null,
    options.reason || null,
    options.result || null,
    options.metadata ? JSON.stringify(options.metadata) : null
  );
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
  if (isRateLimited(registrationAttempts, getClientKey(request), 5, registrationWindowMs)) {
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
    'SELECT id FROM registrations WHERE event_id = ? AND illuminate_id = ? AND status != \'removed\''
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
  const expiresAt = event.ends_at || null;

  try {
    database.exec('BEGIN');
    database.prepare(`
      INSERT INTO registrations (id, event_id, name, email, phone, illuminate_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(registrationId, eventId, registration.name, registration.email, registration.phone, registration.illuminateId, createdAt);
    database.prepare(`
      INSERT INTO passes (id, registration_id, token_hash, issued_at, expires_at, qr_payload_encrypted)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(passId, registrationId, tokenHash, createdAt, expiresAt, encryptPayload(qrPayload));
    writeAudit('registration_created', registrationId, null, { metadata: { eventId } });
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    if (String(error.message || '').includes('UNIQUE constraint failed: registrations.event_id, registrations.illuminate_id')) {
      sendError(response, 409, 'This Illuminate ID has already been registered.');
      return;
    }
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
  if (isRateLimited(loginAttempts, `${getClientKey(request)}:${email}`, 5, 15 * 60 * 1000)) {
    sendError(response, 429, 'Too many login attempts. Please try again later.');
    return;
  }
  const account = database.prepare(`
    SELECT id, email, password_hash AS passwordHash, display_name AS name
    FROM admin_users
    WHERE email = ? AND active = 1
  `).get(email);
  if (!account || !verifyPassword(password, account.passwordHash)) {
    sendError(response, 401, 'Those admin credentials are not recognized.');
    return;
  }
  const sessionId = randomBytes(32).toString('base64url');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + sessionDurationMs).toISOString();
  database.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ? OR expires_at <= ?').run(account.id, createdAt.toISOString());
  database.prepare(`
    INSERT INTO admin_sessions (id_hash, admin_user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(hashSessionId(sessionId), account.id, createdAt.toISOString(), expiresAt);
  database.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(createdAt.toISOString(), account.id);
  writeAudit('admin_login', account.id, account.id, { result: 'accepted' });
  setSessionCookie(response, sessionId);
  sendJson(response, 200, { name: account.name });
}

function handleAdminLogout(request, response) {
  const sessionId = getCookies(request).admin_session;
  const session = getAdminSession(request);
  if (sessionId) {
    database.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE id_hash = ?').run(new Date().toISOString(), hashSessionId(sessionId));
  }
  if (session) {
    writeAudit('admin_logout', session.adminUserId, session.adminUserId, { result: 'accepted' });
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
  const session = requireAdmin(request, response);
  if (!session) {
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
    writeAudit('registration_removed', registrationId, session.adminUserId, { reason, result: 'accepted' });
    database.exec('COMMIT');
  } catch {
    database.exec('ROLLBACK');
    sendError(response, 500, 'Registration could not be removed.');
    return;
  }
  sendJson(response, 200, { ok: true });
}

async function handleVerifyPass(request, response) {
  const session = requireAdmin(request, response);
  if (!session) {
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
  let token = null;
  if (value.startsWith('EVP1.')) {
    const payload = value.match(/^EVP1\.([A-Za-z0-9-]+)\.([A-Za-z0-9_-]{43})$/);
    if (!payload || payload[1] !== eventId) {
      sendJson(response, 400, { result: 'not_found', message: 'This pass is not valid for the selected event.' });
      return;
    }
    token = payload[2];
  }
  const event = database.prepare('SELECT id, status, starts_at AS startsAt, ends_at AS endsAt FROM events WHERE id = ?').get(eventId);
  const now = new Date();
  if (!event || event.status !== 'open' || (event.startsAt && now < new Date(event.startsAt)) || (event.endsAt && now > new Date(event.endsAt))) {
    sendJson(response, 409, { result: 'event_unavailable', message: 'This event is not currently accepting entry.' });
    return;
  }
  let pass;
  if (token) {
    pass = database.prepare(`
      SELECT p.id AS passId, p.status AS passStatus, r.name, r.email, r.phone,
        r.illuminate_id AS illuminateId, r.status, p.expires_at AS expiresAt
      FROM passes p JOIN registrations r ON r.id = p.registration_id
      WHERE p.token_hash = ? AND r.event_id = ?
    `).get(createHash('sha256').update(token).digest('hex'), eventId);
  } else {
    pass = database.prepare(`
      SELECT p.id AS passId, p.status AS passStatus, r.name, r.email, r.phone,
        r.illuminate_id AS illuminateId, r.status, p.expires_at AS expiresAt
      FROM passes p JOIN registrations r ON r.id = p.registration_id
      WHERE p.id = ? AND r.event_id = ?
    `).get(value.toUpperCase(), eventId);
  }
  if (!pass) {
    sendJson(response, 404, { result: 'not_found', message: 'Pass not found.' });
    return;
  }
  if (pass.status === 'removed' || pass.passStatus === 'revoked') {
    sendJson(response, 403, { result: 'revoked', message: 'This pass was removed or revoked.', attendee: { name: pass.name, illuminateId: pass.illuminateId } });
    return;
  }
  if (pass.expiresAt && now > new Date(pass.expiresAt)) {
    database.prepare('UPDATE passes SET status = \'expired\' WHERE id = ? AND status = \'active\'').run(pass.passId);
    sendJson(response, 403, { result: 'expired', message: 'This pass has expired.', attendee: { name: pass.name, illuminateId: pass.illuminateId } });
    return;
  }
  if (pass.status !== 'approved' && pass.status !== 'active') {
    sendJson(response, 403, { result: 'registration_not_eligible', message: 'This registration is not eligible for entry.' });
    return;
  }
  if (pass.passStatus === 'used') {
    sendJson(response, 409, { result: 'already_used', message: 'This pass has already been used.', attendee: { name: pass.name, illuminateId: pass.illuminateId } });
    return;
  }
  try {
    database.exec('BEGIN IMMEDIATE');
    const updated = database.prepare(`
      UPDATE passes SET status = 'used', used_at = ?
      WHERE id = ? AND status = 'active'
    `).run(now.toISOString(), pass.passId);
    if (updated.changes !== 1) {
      database.exec('ROLLBACK');
      sendJson(response, 409, { result: 'already_used', message: 'This pass has already been used.' });
      return;
    }
    database.prepare(`
      INSERT INTO check_ins (id, event_id, pass_id, result, checked_in_at, admin_user_id)
      VALUES (?, ?, ?, 'accepted', ?, ?)
    `).run(randomUUID(), eventId, pass.passId, now.toISOString(), session.adminUserId);
    writeAudit('pass_checked_in', pass.passId, session.adminUserId, { result: 'accepted', metadata: { eventId } });
    database.exec('COMMIT');
  } catch {
    database.exec('ROLLBACK');
    sendError(response, 500, 'Pass verification could not be completed.');
    return;
  }
  sendJson(response, 200, {
    result: 'accepted',
    message: 'Pass accepted. Entry recorded.',
    attendee: { name: pass.name, illuminateId: pass.illuminateId }
  });
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
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
  });
  response.end(readFileSync(filePath));
}

const server = createServer(async (request, response) => {
  response.localOrigin = getLocalOrigin(request);
  const requestPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
  if (request.method === 'OPTIONS' && requestPath.startsWith('/api/')) {
    if (!hasTrustedOrigin(request)) {
      sendError(response, 403, 'Origin is not allowed.');
      return;
    }
    response.writeHead(204, {
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      ...(response.localOrigin ? {
        'Access-Control-Allow-Origin': response.localOrigin,
        Vary: 'Origin'
      } : {})
    });
    response.end();
    return;
  }
  if (request.method === 'POST' && requestPath.startsWith('/api/admin/') && !hasTrustedOrigin(request)) {
    sendError(response, 403, 'Origin is not allowed.');
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