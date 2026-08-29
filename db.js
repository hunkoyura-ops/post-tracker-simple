import fs from "fs";
import path from "path";

// DATA_DIR lets you point storage at a mounted persistent volume
// (e.g. on Railway: set DATA_DIR=/app/data and mount a volume there).
// Defaults to the current folder for plain local use.
const DATA_DIR = process.env.DATA_DIR || process.cwd();
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "data.json");

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    return { posts: [] };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function insertPost(post) {
  const db = loadDb();
  db.posts.push(post);
  saveDb(db);
  return post;
}

function updatePost(id, updates) {
  const db = loadDb();
  const idx = db.posts.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  db.posts[idx] = { ...db.posts[idx], ...updates };
  saveDb(db);
  return db.posts[idx];
}

// Records an event against a post and applies field changes in one write,
// so the stored numbers and the log can never drift apart.
function updatePostWithEvent(id, updates, event) {
  const db = loadDb();
  const idx = db.posts.findIndex((p) => p.id === id);
  if (idx === -1) return null;

  const current = db.posts[idx];
  const history = Array.isArray(current.history) ? current.history : [];

  db.posts[idx] = {
    ...current,
    ...updates,
    history: event ? [...history, event] : history,
  };
  saveDb(db);
  return db.posts[idx];
}

// Every logged event across a campaign, newest first.
function getActivity(campaignId, limit = 60) {
  const db = loadDb();
  const events = [];
  for (const p of db.posts) {
    if (campaignId && p.campaignId !== campaignId) continue;
    for (const e of p.history || []) {
      events.push({
        ...e,
        postId: p.id,
        creatorName: p.creatorName,
        campaignId: p.campaignId,
        platform: p.platform,
      });
    }
  }
  return events.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}

function getQueue(campaignId, creatorId) {
  const db = loadDb();
  return db.posts.filter(
    (p) =>
      p.status === "pending_review" &&
      (!campaignId || p.campaignId === campaignId) &&
      (!creatorId || p.creatorId === creatorId)
  );
}

function getApprovedForCampaign(campaignId) {
  const db = loadDb();
  return db.posts.filter((p) => p.status === "approved" && p.campaignId === campaignId);
}

// Distinct creators seen so far, for the filter dropdown.
function getCreators() {
  const db = loadDb();
  const seen = new Map();
  for (const p of db.posts) {
    if (!seen.has(p.creatorId)) {
      seen.set(p.creatorId, { creatorId: p.creatorId, creatorName: p.creatorName });
    }
  }
  return [...seen.values()].sort((a, b) => a.creatorName.localeCompare(b.creatorName));
}

// All approved posts for one creator, across every campaign.
function getApprovedForCreator(creatorId) {
  const db = loadDb();
  return db.posts.filter((p) => p.status === "approved" && p.creatorId === creatorId);
}

function getPost(id) {
  const db = loadDb();
  return db.posts.find((p) => p.id === id) || null;
}

export {
  insertPost,
  updatePost,
  updatePostWithEvent,
  getActivity,
  getQueue,
  getApprovedForCampaign,
  getCreators,
  getApprovedForCreator,
  getPost,
};
