import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { MongoClient } from 'mongodb';

const eventId = 'illuminate-2026';
const eventName = 'Illuminate Verification';
const passEncryptionKey = process.env.PASS_ENCRYPTION_KEY;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || 'online_event_verification';

const encryptionKey = createHash('sha256').update(passEncryptionKey || '').digest();
let clientPromise;
let indexesPromise;

function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(mongoUri, {
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 20_000,
      connectTimeoutMS: 10_000,
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 15_000
    });
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getCollections() {
  const client = await getClient();
  const db = client.db(databaseName);
  if (!indexesPromise) {
    indexesPromise = Promise.all([
      db.collection('events').createIndex({ id: 1 }, { unique: true }),
      db.collection('registrations').createIndex(
        { eventId: 1, illuminateId: 1 },
        { unique: true, partialFilterExpression: { status: { $ne: 'removed' } } }
      ),
      db.collection('registrations').createIndex({ eventId: 1, createdAt: -1 }),
      db.collection('passes').createIndex({ id: 1 }, { unique: true }),
      db.collection('passes').createIndex({ tokenHash: 1 }, { unique: true }),
      db.collection('passes').createIndex({ registrationId: 1 }, { unique: true }),
      db.collection('adminUsers').createIndex({ email: 1 }, { unique: true }),
      db.collection('adminSessions').createIndex({ idHash: 1 }, { unique: true }),
      db.collection('adminSessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('checkIns').createIndex({ eventId: 1, passId: 1 }, { unique: true }),
      db.collection('auditLogs').createIndex({ createdAt: -1 })
    ]).catch((error) => {
      indexesPromise = null;
      throw error;
    });
  }
  await indexesPromise;
  return {
    client,
    db,
    events: db.collection('events'),
    registrations: db.collection('registrations'),
    passes: db.collection('passes'),
    adminUsers: db.collection('adminUsers'),
    adminSessions: db.collection('adminSessions'),
    checkIns: db.collection('checkIns'),
    auditLogs: db.collection('auditLogs')
  };
}

function json(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

function error(res, status, message) {
  json(res, status, { error: message });
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return null;
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const [name, ...value] = part.trim().split('=');
    return [name, decodeURIComponent(value.join('='))];
  }));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function passwordIsValid(password, encoded) {
  const [algorithm, cost, blockSize, parallelization, salt, digest] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !cost || !blockSize || !parallelization || !salt || !digest) return false;
  const expected = Buffer.from(digest, 'base64url');
  if (expected.length !== 64) return false;
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(cost), r: Number(blockSize), p: Number(parallelization), maxmem: 32 * 1024 * 1024
  });
  return timingSafeEqual(actual, expected);
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function decryptPayload(value) {
  const packed = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}

function normalizeRegistration(input) {
  return {
    name: String(input?.name || '').trim().replace(/\s+/g, ' '),
    email: String(input?.email || '').trim().toLowerCase(),
    phone: String(input?.phone || '').trim(),
    illuminateId: String(input?.illuminateId || '').trim().toUpperCase()
  };
}

function validRegistration(value) {
  return value.name.length >= 2 && value.name.length <= 120
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) && value.email.length <= 254
    && value.phone.replace(/\D/g, '').length >= 10 && value.phone.length <= 30
    && /^[A-Z0-9-]{3,40}$/.test(value.illuminateId);
}

async function audit(collections, action, entityId, actorAdminId, details = {}) {
  await collections.auditLogs.insertOne({
    id: randomUUID(), action, entityId, actorAdminId: actorAdminId || null,
    reason: details.reason || null, result: details.result || null,
    metadata: details.metadata || null, createdAt: new Date()
  });
}

async function ensureConfiguredAdmin(collections) {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const passwordHash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (!email || !passwordHash) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD_HASH must be configured.');
  await collections.adminUsers.updateOne(
    { email },
    { $set: { email, passwordHash, displayName: process.env.ADMIN_NAME || 'Event Administrator', active: true }, $setOnInsert: { id: randomUUID(), createdAt: new Date() } },
    { upsert: true }
  );
}

async function sessionFor(req, collections) {
  const raw = cookies(req).admin_session;
  if (!raw) return null;
  const session = await collections.adminSessions.findOne({ idHash: hash(raw), revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!session) return null;
  const admin = await collections.adminUsers.findOne({ id: session.adminUserId, active: true });
  return admin ? { ...session, name: admin.displayName, role: admin.role } : null;
}

function setCookie(res, value, maxAge = 28_800) {
  res.setHeader('Set-Cookie', `admin_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}; Secure`);
}

async function registration(req, res, collections) {
  const value = normalizeRegistration(parseBody(req));
  if (!validRegistration(value)) return error(res, 400, 'Please check the registration details and try again.');
  const event = await collections.events.findOneAndUpdate(
    { id: eventId },
    { $setOnInsert: { id: eventId, name: eventName, status: 'open', createdAt: new Date() } },
    { upsert: true, returnDocument: 'after' }
  );
  if (event.status !== 'open') return error(res, 409, 'Registration is currently closed.');
  const activeDuplicate = await collections.registrations.findOne({ eventId, illuminateId: value.illuminateId, status: { $ne: 'removed' } });
  if (activeDuplicate) return error(res, 409, 'This Illuminate ID has already been registered.');

  const createdAt = new Date();
  const registrationId = randomUUID();
  const passId = `PASS-${randomBytes(4).toString('hex').toUpperCase()}`;
  const token = randomBytes(32).toString('base64url');
  const payload = `EVP1.${eventId}.${token}`;
  const pass = { id: passId, registrationId, eventId, tokenHash: hash(token), status: 'active', issuedAt: createdAt, expiresAt: null, qrPayloadEncrypted: encrypt(payload) };
  const registrationDoc = { id: registrationId, eventId, ...value, status: 'approved', createdAt, updatedAt: createdAt };
  const mongoSession = collections.client.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await collections.registrations.insertOne(registrationDoc, { session: mongoSession });
      await collections.passes.insertOne(pass, { session: mongoSession });
      await collections.auditLogs.insertOne({
        id: randomUUID(), action: 'registration_created', entityId: registrationId,
        actorAdminId: null, reason: null, result: null, metadata: { eventId }, createdAt: new Date()
      }, { session: mongoSession });
    });
  } catch (caught) {
    if (caught.code === 11000) return error(res, 409, 'This Illuminate ID has already been registered.');
    throw caught;
  } finally {
    await mongoSession.endSession();
  }
  const qrDataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
  return json(res, 201, { name: value.name, illuminateId: value.illuminateId, passId, qrDataUrl });
}

async function login(req, res, collections) {
  const input = parseBody(req) || {};
  const email = String(input.email || '').trim().toLowerCase();
  const account = await collections.adminUsers.findOne({ email, active: true });
  if (!account || !passwordIsValid(String(input.password || ''), account.passwordHash)) return error(res, 401, 'Those admin credentials are not recognized.');
  const sessionId = randomBytes(32).toString('base64url');
  const now = new Date();
  await collections.adminSessions.deleteMany({ $or: [{ adminUserId: account.id }, { expiresAt: { $lte: now } }] });
  await collections.adminSessions.insertOne({ idHash: hash(sessionId), adminUserId: account.id, createdAt: now, expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000), revokedAt: null });
  await collections.adminUsers.updateOne({ id: account.id }, { $set: { lastLoginAt: now } });
  await audit(collections, 'admin_login', account.id, account.id, { result: 'accepted' });
  setCookie(res, sessionId);
  return json(res, 200, { name: account.displayName });
}

async function registrations(req, res, collections, session) {
  const rows = await collections.registrations.find({ eventId, status: { $ne: 'removed' } }).sort({ createdAt: -1 }).toArray();
  const result = await Promise.all(rows.map(async (row) => {
    const pass = await collections.passes.findOne({ registrationId: row.id });
    return { id: row.id, name: row.name, email: row.email, phone: row.phone, illuminateId: row.illuminateId, status: row.status, createdAt: row.createdAt, passId: pass?.id, passStatus: pass?.status, qrDataUrl: pass?.qrPayloadEncrypted ? await QRCode.toDataURL(decryptPayload(pass.qrPayloadEncrypted), { errorCorrectionLevel: 'M', margin: 2, width: 220 }) : null };
  }));
  return json(res, 200, { registrations: result });
}

async function removeRegistration(req, res, collections, session, registrationId) {
  const reason = String(parseBody(req)?.reason || '').trim();
  if (reason.length < 3 || reason.length > 250) return error(res, 400, 'A removal reason is required.');
  const registration = await collections.registrations.findOne({ id: registrationId, eventId, status: { $ne: 'removed' } });
  if (!registration) return error(res, 404, 'Registration not found.');
  const now = new Date();
  const mongoSession = collections.client.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await collections.registrations.updateOne(
        { id: registrationId, eventId, status: { $ne: 'removed' } },
        { $set: { status: 'removed', removedAt: now, removedBy: session.adminUserId, removalReason: reason, updatedAt: now } },
        { session: mongoSession }
      );
      await collections.passes.updateMany(
        { registrationId, status: 'active' },
        { $set: { status: 'revoked', revokedAt: now, revocationReason: reason, revokedBy: session.adminUserId } },
        { session: mongoSession }
      );
      await collections.auditLogs.insertOne({
        id: randomUUID(), action: 'registration_removed', entityId: registrationId,
        actorAdminId: session.adminUserId, reason, result: 'accepted', metadata: { eventId }, createdAt: now
      }, { session: mongoSession });
    });
  } finally {
    await mongoSession.endSession();
  }
  return json(res, 200, { ok: true });
}

async function verify(req, res, collections, session) {
  const value = String(parseBody(req)?.value || '').trim();
  if (!value) return error(res, 400, 'Enter or scan a pass.');
  let token = null;
  if (value.startsWith('EVP1.')) {
    const match = value.match(/^EVP1\.([A-Za-z0-9-]+)\.([A-Za-z0-9_-]{43})$/);
    if (!match || match[1] !== eventId) return json(res, 400, { result: 'not_found', message: 'This pass is not valid for the selected event.' });
    token = match[2];
  }
  const pass = token
    ? await collections.passes.findOne({ eventId, tokenHash: hash(token) })
    : await collections.passes.findOne({ eventId, id: value.toUpperCase() });
  if (!pass) return json(res, 404, { result: 'not_found', message: 'Pass not found.' });
  const attendee = await collections.registrations.findOne({ id: pass.registrationId, eventId });
  if (!attendee || attendee.status === 'removed' || pass.status === 'revoked') return json(res, 403, { result: 'revoked', message: 'This pass was removed or revoked.' });
  if (pass.status === 'used') return json(res, 409, { result: 'already_used', message: 'This pass has already been used.', attendee: { name: attendee.name, illuminateId: attendee.illuminateId } });
  const now = new Date();
  const mongoSession = collections.client.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      const updated = await collections.passes.findOneAndUpdate(
        { id: pass.id, status: 'active' },
        { $set: { status: 'used', usedAt: now } },
        { returnDocument: 'after', session: mongoSession }
      );
      if (!updated) throw new Error('PASS_ALREADY_USED');
      await collections.checkIns.insertOne({ id: randomUUID(), eventId, passId: pass.id, result: 'accepted', checkedInAt: now, adminUserId: session.adminUserId }, { session: mongoSession });
      await collections.auditLogs.insertOne({
        id: randomUUID(), action: 'pass_checked_in', entityId: pass.id,
        actorAdminId: session.adminUserId, reason: null, result: 'accepted', metadata: { eventId }, createdAt: now
      }, { session: mongoSession });
    });
  } catch (caught) {
    if (caught.message === 'PASS_ALREADY_USED') return json(res, 409, { result: 'already_used', message: 'This pass has already been used.' });
    throw caught;
  } finally {
    await mongoSession.endSession();
  }
  return json(res, 200, { result: 'accepted', message: 'Pass accepted. Entry recorded.', attendee: { name: attendee.name, illuminateId: attendee.illuminateId } });
}

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (!passEncryptionKey) return error(res, 500, 'PASS_ENCRYPTION_KEY must be configured.');
    if (!mongoUri) return error(res, 500, 'MONGODB_URI must be configured.');

    const collections = await getCollections();
    await collections.events.updateOne({ id: eventId }, { $setOnInsert: { id: eventId, name: eventName, status: 'open', createdAt: new Date() } }, { upsert: true });
    await ensureConfiguredAdmin(collections);
    const path = new URL(req.url, 'https://vercel.local').pathname.replace(/\/index$/, '');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method === 'POST' && path === '/api/events/illuminate-2026/registrations') return registration(req, res, collections);
    if (req.method === 'POST' && path === '/api/admin/login') return login(req, res, collections);
    const session = await sessionFor(req, collections);
    if (!session) return error(res, 401, 'Admin authentication is required.');
    if (req.method === 'GET' && path === '/api/admin/registrations') return registrations(req, res, collections, session);
    if (req.method === 'POST' && path.startsWith('/api/admin/registrations/')) {
      return removeRegistration(req, res, collections, session, path.split('/')[4]);
    }
    if (req.method === 'POST' && path === '/api/admin/verify') return verify(req, res, collections, session);
    if (req.method === 'POST' && path === '/api/admin/logout') {
      const raw = cookies(req).admin_session;
      await collections.adminSessions.updateOne({ idHash: hash(raw) }, { $set: { revokedAt: new Date() } });
      setCookie(res, '', 0);
      return json(res, 200, { ok: true });
    }
    return error(res, 404, 'Not found.');
  } catch (caught) {
    console.error('API request failed:', caught);
    return error(res, 500, 'The service could not complete this request.');
  }
}
