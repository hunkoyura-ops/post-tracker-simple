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

function getQueue(campaignId) {
  const db = loadDb();
  return db.posts.filter(
    (p) => p.status === "pending_review" && (!campaignId || p.campaignId === campaignId)
  );
}

function getApprovedForCampaign(campaignId) {
  const db = loadDb();
  return db.posts.filter((p) => p.status === "approved" && p.campaignId === campaignId);
}

function getPost(id) {
  const db = loadDb();
  return db.posts.find((p) => p.id === id) || null;
}

export { insertPost, updatePost, getQueue, getApprovedForCampaign, getPost };
