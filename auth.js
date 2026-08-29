import crypto from "crypto";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "";
const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || BOT_TOKEN;

const MAX_AUTH_AGE_SECONDS = 300; // Telegram payload must be fresh (5 min)
const SESSION_DAYS = 30;
const COOKIE_NAME = "pt_session";

// Auth is opt-in: with no bot token configured the app behaves as before.
const AUTH_ENABLED = Boolean(BOT_TOKEN && BOT_USERNAME);

if (!AUTH_ENABLED) {
  console.warn(
    "[auth] Telegram login is OFF — anyone with the URL can open this app.\n" +
      "       Set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_ALLOWED_IDS to enable it."
  );
} else if (ALLOWED_IDS.length === 0) {
  console.warn(
    "[auth] TELEGRAM_ALLOWED_IDS is empty — every Telegram user would be able to log in.\n" +
      "       Add the Telegram numeric IDs that should have access."
  );
}

// ---- Telegram Login Widget verification ----------------------------------
// Per Telegram's spec: secret key is SHA256(bot_token), and the signature is
// HMAC-SHA256 over "key=value" lines sorted alphabetically, minus the hash.
function verifyTelegramAuth(query) {
  const { hash, ...fields } = query;
  if (!hash || typeof hash !== "string") return null;

  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const computed = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  // Reject replayed / stale payloads.
  const authDate = Number(fields.auth_date || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > MAX_AUTH_AGE_SECONDS) {
    return null;
  }

  return {
    id: String(fields.id),
    username: fields.username || null,
    firstName: fields.first_name || null,
  };
}

function isAllowed(userId) {
  if (ALLOWED_IDS.length === 0) return true; // warned about above
  return ALLOWED_IDS.includes(String(userId));
}

// ---- Signed session cookie (stateless, no session store) ------------------

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const [body, sig] = cookieValue.split(".");
  if (!body || !sig) return null;

  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!isAllowed(payload.id)) return null; // revoked since the cookie was issued
    return payload;
  } catch {
    return null;
  }
}

function makeSessionCookie(user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const value = signSession({ id: user.id, username: user.username, exp });
  return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax; Secure`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

// Minimal cookie parsing — avoids pulling in another dependency.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();

  const cookies = parseCookies(req.headers.cookie);
  const session = readSession(cookies[COOKIE_NAME]);
  if (session) {
    req.user = session;
    return next();
  }

  // API calls get a status code; page loads get sent to the login screen.
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
  .box { max-width: 380px; width: 100%; text-align: center; }
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
  .widget { display: flex; justify-content: center; }
</style>
</head>
<body>
  <div class="box">
    <p class="eyebrow">INFLUENCE &amp; CONTENT OPS</p>
    <h1>Post <span class="arrow">→</span> Report</h1>
    ${message}
    <div class="widget">
      <script async src="https://telegram.org/js/telegram-widget.js?22"
        data-telegram-login="${BOT_USERNAME}"
        data-size="large"
        data-radius="8"
        data-auth-url="/auth/telegram"
        data-request-access="write"></script>
    </div>
  </div>
</body>
</html>`;
}

export {
  AUTH_ENABLED,
  verifyTelegramAuth,
  isAllowed,
  makeSessionCookie,
  clearSessionCookie,
  requireAuth,
  renderLoginPage,
};
