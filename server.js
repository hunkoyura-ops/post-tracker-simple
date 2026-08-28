import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";

import { extractMetrics, generateNarrative } from "./claude.js";
import { validateMetrics } from "./validate.js";
import {
  insertPost,
  updatePost,
  getQueue,
  getApprovedForCampaign,
  getCreators,
  getApprovedForCreator,
} from "./db.js";

dotenv.config();

const app = express();
app.use(express.json());
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

app.post("/api/queue/:id/approve", (req, res) => {
  const updates = { status: "approved", ...req.body };
  const post = updatePost(req.params.id, updates);
  if (!post) return res.status(404).json({ error: "Не знайдено" });
  res.json(post);
});

app.post("/api/queue/:id/reject", (req, res) => {
  const post = updatePost(req.params.id, { status: "rejected" });
  if (!post) return res.status(404).json({ error: "Не знайдено" });
  res.json(post);
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

app.get("/api/campaigns/:campaignId/report", async (req, res) => {
  try {
    const posts = getApprovedForCampaign(req.params.campaignId);
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

app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
