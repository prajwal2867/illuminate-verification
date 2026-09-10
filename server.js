import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
    expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

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

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
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
      INSERT INTO passes (id, registration_id, token_hash, issued_at)
      VALUES (?, ?, ?, ?)
    `).run(passId, registrationId, tokenHash, createdAt);
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
  if (request.method === 'POST' && request.url === '/api/events/illuminate-2026/registrations') {
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