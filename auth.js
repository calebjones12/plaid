const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE_NAME = 'plaid_sid';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

const loginAttempts = new Map();
let cachedPasswordHash = null;

function requireAuthConfig() {
  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  const secret = String(process.env.SESSION_SECRET || '').trim();

  if (!username || !(password || passwordHash)) {
    const error = new Error(
      'Login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) in .env.'
    );
    error.code = 'AUTH_NOT_CONFIGURED';
    throw error;
  }

  if (!secret || secret.length < 16) {
    const error = new Error(
      'SESSION_SECRET is missing or too short. Set a random string of at least 16 characters in .env.'
    );
    error.code = 'AUTH_NOT_CONFIGURED';
    throw error;
  }

  return { username, password, passwordHash, secret };
}

function getPasswordHash() {
  const { password, passwordHash } = requireAuthConfig();
  if (passwordHash) return passwordHash;
  if (!cachedPasswordHash) {
    cachedPasswordHash = bcrypt.hashSync(password, 10);
  }
  return cachedPasswordHash;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  const size = Math.max(a.length, b.length, 1);
  const aPad = Buffer.alloc(size);
  const bPad = Buffer.alloc(size);
  a.copy(aPad);
  b.copy(bPad);
  return crypto.timingSafeEqual(aPad, bPad) && a.length === b.length;
}

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function getLock(req) {
  const key = clientKey(req);
  const record = loginAttempts.get(key);
  if (!record) return null;
  if (record.lockedUntil && record.lockedUntil > Date.now()) return record;
  if (record.lockedUntil && record.lockedUntil <= Date.now()) {
    loginAttempts.delete(key);
    return null;
  }
  if (record.firstAt && Date.now() - record.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  return record;
}

function registerFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const record = loginAttempts.get(key) || { count: 0, firstAt: now, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_WINDOW_MS;
  }
  loginAttempts.set(key, record);
}

function clearFailures(req) {
  loginAttempts.delete(clientKey(req));
}

function cookieOptions(req) {
  const forced = String(process.env.COOKIE_SECURE || '').toLowerCase();
  const secure = forced === 'true' ? true : forced === 'false' ? false : Boolean(req.secure);
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MS,
  };
}

function signSession(username, secret) {
  const payload = Buffer.from(
    JSON.stringify({
      u: username,
      exp: Date.now() + SESSION_MS,
    })
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(req) {
  try {
    const { secret, username } = requireAuthConfig();
    const token = req.cookies?.[COOKIE_NAME];
    if (!token || typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.u || !data.exp || data.exp < Date.now()) return null;
    if (!safeEqual(data.u, username)) return null;
    return { username: data.u };
  } catch (error) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Please sign in.' });
  }
  req.user = session;
  return next();
}

function setSessionCookie(req, res, username) {
  const { secret } = requireAuthConfig();
  res.cookie(COOKIE_NAME, signSession(username, secret), cookieOptions(req));
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(req), maxAge: 0 });
}

async function verifyLogin(username, password) {
  const config = requireAuthConfig();
  const usernameOk = safeEqual(username, config.username);
  const passwordOk = await bcrypt.compare(String(password || ''), getPasswordHash());
  return usernameOk && passwordOk;
}

function envFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function isAdmin() {
  return envFlag(process.env.IS_ADMIN);
}

function requireAdmin(req, res, next) {
  if (!isAdmin()) {
    return res.status(403).json({ success: false, error: 'Settings are available to admin only.' });
  }
  return next();
}

module.exports = {
  COOKIE_NAME,
  requireAuthConfig,
  requireAuth,
  requireAdmin,
  isAdmin,
  readSession,
  getLock,
  registerFailure,
  clearFailures,
  setSessionCookie,
  clearSessionCookie,
  verifyLogin,
  LOGIN_WINDOW_MS,
};
