import crypto from "crypto";

const CLIENT_ID = process.env.TELEGRAM_CLIENT_ID || "";
const CLIENT_SECRET = process.env.TELEGRAM_CLIENT_SECRET || "";
const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SESSION_SECRET = process.env.SESSION_SECRET || CLIENT_SECRET;

const ISSUER = "https://oauth.telegram.org";
const AUTH_ENDPOINT = `${ISSUER}/auth`;
const TOKEN_ENDPOINT = `${ISSUER}/token`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

const SESSION_DAYS = 30;
const COOKIE_NAME = "pt_session";
const FLOW_COOKIE = "pt_oidc";
const FLOW_MAX_AGE = 600; // 10 minutes to finish signing in

// Auth is opt-in: without credentials the app behaves as it did before.
const AUTH_ENABLED = Boolean(CLIENT_ID && CLIENT_SECRET);

if (!AUTH_ENABLED) {
  console.warn(
    "[auth] Telegram sign-in is OFF — anyone with the URL can open this app.\n" +
      "       Set TELEGRAM_CLIENT_ID, TELEGRAM_CLIENT_SECRET and TELEGRAM_ALLOWED_IDS to enable it."
  );
} else if (ALLOWED_IDS.length === 0) {
  console.warn(
    "[auth] TELEGRAM_ALLOWED_IDS is empty — any Telegram user could sign in.\n" +
      "       Add the numeric Telegram IDs that should have access."
  );
}

// ---- small helpers --------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(value, secret = SESSION_SECRET) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function packCookie(payload, secret = SESSION_SECRET) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

function unpackCookie(value, secret = SESSION_SECRET) {
  if (!value || typeof value !== "string") return null;
  const [body, sig] = value.split(".");
  if (!body || !sig || !safeEqual(sig, sign(body, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- ID token verification -----------------------------------------------
// Pure function so it can be tested with locally generated keys.
function verifyIdToken(token, { jwks, clientId, issuer = ISSUER, now = Date.now() }) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };

  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return { ok: false, reason: "unreadable token" };
  }

  const keys = jwks.keys || [];
  // If the token names a key, that exact key must exist — falling back to
  // another one would let a token signed with any Telegram key pass.
  const jwk = header.kid
    ? keys.find((k) => k.kid === header.kid)
    : keys.find((k) => k.alg === header.alg);
  if (!jwk) return { ok: false, reason: "no matching signing key" };

  const ALGS = {
    RS256: { verify: "RSA-SHA256" },
    ES256: { verify: "sha256", dsaEncoding: "ieee-p1363" },
  };
  const alg = ALGS[header.alg];
  if (!alg) return { ok: false, reason: `unsupported algorithm ${header.alg}` };

  let key;
  try {
    key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return { ok: false, reason: "bad signing key" };
  }

  const verifier = crypto.createVerify(alg.verify);
  verifier.update(`${headerB64}.${payloadB64}`);
  const signatureValid = verifier.verify(
    alg.dsaEncoding ? { key, dsaEncoding: alg.dsaEncoding } : key,
    Buffer.from(sigB64, "base64url")
  );
  if (!signatureValid) return { ok: false, reason: "signature does not match" };

  if (payload.iss !== issuer) return { ok: false, reason: "wrong issuer" };
  if (String(payload.aud) !== String(clientId)) return { ok: false, reason: "wrong audience" };
  if (!payload.exp || payload.exp * 1000 <= now) return { ok: false, reason: "token expired" };

  return {
    ok: true,
    user: {
      id: String(payload.id ?? payload.sub),
      username: payload.preferred_username || null,
      name: payload.name || null,
    },
  };
}

// ---- JWKS (cached; signing keys rotate rarely) ----------------------------

let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;

async function getJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Could not fetch Telegram signing keys (${res.status})`);
  const keys = await res.json();
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

// ---- OIDC flow ------------------------------------------------------------

// Telegram normalises registered Redirect URLs with a trailing slash, and the
// comparison at their end is exact — so the value we send must carry it too.
// TELEGRAM_REDIRECT_URI overrides this if your registered URL differs.
const REDIRECT_URI_OVERRIDE = process.env.TELEGRAM_REDIRECT_URI || "";

function redirectUri(req) {
  if (REDIRECT_URI_OVERRIDE) return REDIRECT_URI_OVERRIDE;
  const base = APP_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/auth/telegram/callback/`;
}

// Step 1: send the user to Telegram, remembering state + PKCE verifier.
function beginLogin(req, res) {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

  const flow = packCookie({
    state,
    verifier,
    exp: Math.floor(Date.now() / 1000) + FLOW_MAX_AGE,
  });

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  res
    .set(
      "Set-Cookie",
      `${FLOW_COOKIE}=${flow}; HttpOnly; Path=/; Max-Age=${FLOW_MAX_AGE}; SameSite=Lax; Secure`
    )
    .redirect(url.toString());
}

// Step 2: Telegram sends the user back with a code; swap it for an ID token.
async function completeLogin(req) {
  const { code, state } = req.query;
  if (!code || !state) return { ok: false, reason: "missing code" };

  const flow = unpackCookie(parseCookies(req.headers.cookie)[FLOW_COOKIE]);
  if (!flow) return { ok: false, reason: "sign-in took too long, try again" };
  if (!safeEqual(flow.state, state)) return { ok: false, reason: "state mismatch" };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code),
    redirect_uri: redirectUri(req),
    client_id: CLIENT_ID,
    code_verifier: flow.verifier,
  });

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });

  if (!res.ok) {
    return { ok: false, reason: `token exchange failed (${res.status})` };
  }

  const tokens = await res.json();
  if (!tokens.id_token) return { ok: false, reason: "no ID token returned" };

  const jwks = await getJwks();
  const verified = verifyIdToken(tokens.id_token, { jwks, clientId: CLIENT_ID });
  if (!verified.ok) return { ok: false, reason: verified.reason };

  return { ok: true, user: verified.user };
}

function isAllowed(userId) {
  if (ALLOWED_IDS.length === 0) return true; // warned about at startup
  return ALLOWED_IDS.includes(String(userId));
}

// ---- Session --------------------------------------------------------------

function makeSessionCookie(user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const value = packCookie({ id: user.id, username: user.username, exp });
  return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax; Secure`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

function clearFlowCookie() {
  return `${FLOW_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

function readSession(cookieValue) {
  const payload = unpackCookie(cookieValue);
  if (!payload) return null;
  if (!isAllowed(payload.id)) return null; // access revoked since sign-in
  return payload;
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();

  const session = readSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  if (session) {
    req.user = session;
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not signed in" });
  }
  return res.redirect("/login");
}

// ---- Login page -----------------------------------------------------------

function renderLoginPage(error) {
  const message = error
    ? `<p class="err">${error}</p>`
    : `<p class="hint">Доступ лише для команди.</p>`;

  return `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Sign in — Post → Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;500;900&display=swap" rel="stylesheet">
<style>
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: #0a0a0c; color: #f2f2ed;
    font-family: 'Inter', -apple-system, sans-serif;
    padding: 24px;
  }
  .box { max-width: 400px; width: 100%; text-align: center; }
  .eyebrow {
    font-family: 'JetBrains Mono', monospace;
    color: #e8685c; font-size: 11px;
    letter-spacing: 0.16em; text-transform: uppercase;
    margin: 0 0 14px;
  }
  h1 { font-size: 34px; font-weight: 900; margin: 0 0 14px; letter-spacing: -0.02em; }
  h1 .arrow { color: #4fd8c4; padding: 0 8px; }
  .hint, .err {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px; margin: 0 0 32px; line-height: 1.6;
  }
  .hint { color: #63636b; }
  .err { color: #e8685c; }
  .btn {
    display: inline-block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px; font-weight: 600;
    padding: 13px 28px; border-radius: 8px;
    background: #4fd8c4; color: #06201b;
    text-decoration: none;
  }
</style>
</head>
<body>
  <div class="box">
    <p class="eyebrow">INFLUENCE &amp; CONTENT OPS</p>
    <h1>Post <span class="arrow">→</span> Report</h1>
    ${message}
    <a class="btn" href="/auth/telegram">Log in with Telegram</a>
  </div>
</body>
</html>`;
}

export {
  AUTH_ENABLED,
  beginLogin,
  completeLogin,
  verifyIdToken,
  isAllowed,
  makeSessionCookie,
  clearSessionCookie,
  clearFlowCookie,
  requireAuth,
  renderLoginPage,
};
