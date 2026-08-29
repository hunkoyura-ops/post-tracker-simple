// Must be first: auth.js reads env vars while it is being imported.
import "dotenv/config";

import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import { extractMetrics, generateNarrative } from "./claude.js";
import { renderReportHtml } from "./report-template.js";
import { validateMetrics } from "./validate.js";
import {
  AUTH_ENABLED,
  beginLogin,
  completeLogin,
  isAllowed,
  makeSessionCookie,
  clearSessionCookie,
  clearFlowCookie,
  requireAuth,
  renderLoginPage,
} from "./auth.js";
import {
  insertPost,
  updatePostWithEvent,
  getActivity,
  getQueue,
  getApprovedForCampaign,
  getCreators,
  getApprovedForCreator,
  getPost,
} from "./db.js";

const app = express();
// Railway terminates TLS in front of the app; without this req.protocol
// would be "http" and the redirect_uri sent to Telegram would not match.
app.set("trust proxy", 1);
app.use(express.json());

// ---- Public: reachable without signing in ----
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/login", (req, res) => {
  if (!AUTH_ENABLED) return res.redirect("/");
  res.set("Content-Type", "text/html; charset=utf-8").send(renderLoginPage(null));
});

// Start: bounce the user to Telegram's consent screen.
app.get("/auth/telegram", (req, res) => {
  if (!AUTH_ENABLED) return res.redirect("/");
  beginLogin(req, res);
});

// Return: Telegram sends a code back here.
app.get("/auth/telegram/callback", async (req, res) => {
  if (!AUTH_ENABLED) return res.redirect("/");

  const sendError = (status, message) =>
    res
      .status(status)
      .set("Set-Cookie", clearFlowCookie())
      .set("Content-Type", "text/html; charset=utf-8")
      .send(renderLoginPage(message));

  try {
    const result = await completeLogin(req);
    if (!result.ok) return sendError(401, `Вхід не вдався: ${result.reason}`);

    if (!isAllowed(result.user.id)) {
      return sendError(
        403,
        `Немає доступу. Ваш Telegram ID: ${result.user.id} — попросіть додати його до списку.`
      );
    }

    res
      .set("Set-Cookie", [makeSessionCookie(result.user), clearFlowCookie()])
      .redirect("/");
  } catch (err) {
    console.error("[auth]", err);
    sendError(500, `Помилка входу: ${err.message}`);
  }
});

app.get("/auth/logout", (req, res) => {
  res.set("Set-Cookie", clearSessionCookie()).redirect("/login");
});

// ---- Everything below needs a session (when auth is switched on) ----
app.use(requireAuth);

app.use(express.static("public"));

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOADS_DIR));

const upload = multer({ dest: UPLOADS_DIR });

app.post("/api/submit", upload.single("screenshot"), async (req, res) => {
  try {
    const { creatorId, creatorName, creatorFollowers, platform, postedAt, campaignId } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Файл скриншота обов'язковий" });

    const imageBase64 = fs.readFileSync(file.path, { encoding: "base64" });
    const mediaType = file.mimetype === "image/png" ? "image/png" : "image/jpeg";

    const extracted = await extractMetrics(imageBase64, mediaType);
    const flags = validateMetrics(extracted, Number(creatorFollowers) || 0);

    const post = {
      id: crypto.randomUUID(),
      campaignId,
      creatorId,
      creatorName,
      platform,
      postedAt,
      screenshotPath: `/uploads/${path.basename(file.path)}`,
      ...extracted,
      flags,
      status: flags.length === 0 ? "approved" : "pending_review",
      createdAt: new Date().toISOString(),
      history: [
        {
          at: new Date().toISOString(),
          action: flags.length === 0 ? "auto_approved" : "flagged",
          by: actorOf(req),
          detail:
            flags.length === 0
              ? "Метрики зчитано, перевірку пройдено"
              : `Зчитано, але позначено: ${flags.join("; ")}`,
        },
      ],
    };

    insertPost(post);
    res.json({ status: post.status, post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/queue", (req, res) => {
  res.json(getQueue(req.query.campaignId, req.query.creatorId));
});

// Who performed the action. Fills in automatically once Telegram sign-in
// is enabled; until then actions are logged without a name.
function actorOf(req) {
  if (!req.user) return null;
  return req.user.username ? "@" + req.user.username : String(req.user.id);
}

const METRIC_FIELDS = ["views", "reach", "impressions", "likes", "comments", "shares", "saves"];

app.post("/api/queue/:id/approve", (req, res) => {
  const existing = getPost(req.params.id);
  if (!existing) return res.status(404).json({ error: "Не знайдено" });

  // Anything in the body that differs from the stored value is a manual fix.
  const corrections = {};
  const changes = [];
  for (const field of METRIC_FIELDS) {
    if (!(field in req.body)) continue;
    const next = req.body[field] === null || req.body[field] === "" ? null : Number(req.body[field]);
    if (next !== existing[field]) {
      corrections[field] = next;
      changes.push(`${field}: ${existing[field] ?? "—"} → ${next ?? "—"}`);
    }
  }

  const now = new Date().toISOString();
  const by = actorOf(req);

  if (changes.length) {
    updatePostWithEvent(req.params.id, corrections, {
      at: now,
      action: "edited",
      by,
      detail: "Виправлено вручну — " + changes.join(", "),
    });
  }

  const post = updatePostWithEvent(
    req.params.id,
    { status: "approved" },
    { at: now, action: "approved", by, detail: "Підтверджено після перевірки" }
  );
  res.json(post);
});

app.post("/api/queue/:id/reject", (req, res) => {
  const post = updatePostWithEvent(
    req.params.id,
    { status: "rejected" },
    {
      at: new Date().toISOString(),
      action: "rejected",
      by: actorOf(req),
      detail: req.body?.reason ? String(req.body.reason).slice(0, 200) : "Відхилено",
    }
  );
  if (!post) return res.status(404).json({ error: "Не знайдено" });
  res.json(post);
});

// Recent activity across a campaign — who did what, newest first.
app.get("/api/activity", (req, res) => {
  res.json(getActivity(req.query.campaignId, Number(req.query.limit) || 60));
});

// Full history for one post.
app.get("/api/posts/:id/history", (req, res) => {
  const post = getPost(req.params.id);
  if (!post) return res.status(404).json({ error: "Не знайдено" });
  res.json({ postId: post.id, creatorName: post.creatorName, history: post.history || [] });
});

// List of creators seen so far — powers the filter dropdown.
app.get("/api/creators", (req, res) => {
  res.json(getCreators());
});

// Aggregate numbers for one creator across ALL campaigns.
// Pure arithmetic, no AI call — instant and free.
app.get("/api/creators/:creatorId/stats", (req, res) => {
  const posts = getApprovedForCreator(req.params.creatorId);

  const totalViews = posts.reduce((s, p) => s + (p.views ?? 0), 0);
  const totalReach = posts.reduce((s, p) => s + (p.reach ?? 0), 0);
  const totalEngagements = posts.reduce(
    (s, p) => s + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.saves ?? 0),
    0
  );
  const campaigns = [...new Set(posts.map((p) => p.campaignId))];

  const perPost = posts
    .map((p) => {
      const reach = p.reach ?? p.views ?? 0;
      const eng = (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.saves ?? 0);
      return {
        id: p.id,
        campaignId: p.campaignId,
        platform: p.platform,
        postedAt: p.postedAt,
        views: p.views,
        reach: p.reach,
        engagementRate: reach > 0 ? eng / reach : 0,
      };
    })
    .sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1));

  res.json({
    creatorId: req.params.creatorId,
    creatorName: posts[0]?.creatorName ?? null,
    postCount: posts.length,
    campaignCount: campaigns.length,
    totalViews,
    totalReach,
    averageEngagementRate: totalReach > 0 ? totalEngagements / totalReach : 0,
    posts: perPost,
  });
});

// Shared so the JSON view and the printable report can never disagree.
function buildCampaignReport(campaignId) {
  const posts = getApprovedForCampaign(campaignId);
  const totalViews = posts.reduce((s, p) => s + (p.views ?? 0), 0);
  const totalReach = posts.reduce((s, p) => s + (p.reach ?? 0), 0);
  const totalEngagements = posts.reduce(
    (s, p) => s + (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0) + (p.saves ?? 0),
    0
  );
  const summary = {
    totalViews,
    totalReach,
    totalEngagements,
    averageEngagementRate: totalReach > 0 ? totalEngagements / totalReach : 0,
    postCount: posts.length,
  };
  return { posts, summary };
}

app.get("/api/campaigns/:campaignId/report", async (req, res) => {
  try {
    const { posts, summary } = buildCampaignReport(req.params.campaignId);
    const narrative =
      posts.length > 0
        ? await generateNarrative(req.params.campaignId, posts, summary)
        : "Ще немає підтверджених постів у цій кампанії.";
    res.json({ summary, narrative, posts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Printable, client-facing report. Open in a tab, then "Save as PDF".
app.get("/campaigns/:campaignId/report.html", async (req, res) => {
  try {
    const { posts, summary } = buildCampaignReport(req.params.campaignId);
    const narrative =
      posts.length > 0
        ? await generateNarrative(req.params.campaignId, posts, summary)
        : "Ще немає підтверджених постів у цій кампанії.";

    const html = renderReportHtml({
      campaignId: req.params.campaignId,
      posts,
      summary,
      narrative,
      generatedAt: new Date().toISOString().slice(0, 10),
    });
    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .set("Content-Type", "text/html; charset=utf-8")
      .send(`<p style="font-family:monospace">Report error: ${err.message}</p>`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
