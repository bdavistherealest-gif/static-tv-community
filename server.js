/**
 * Static TV Community API
 * Lightweight backend for per-episode comments, reactions, and ratings.
 * SQLite storage, deployable to Render/Railway/Fly.io free tier.
 */

const express = require('express');
const cors = require('cors');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '64kb' }));

// --- Database (Node built-in SQLite, no native deps) ---
const dbPath = process.env.DB_PATH || path.join(__dirname, 'community.db');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comments_ep ON comments(tmdb_id, season, episode);

  CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tmdb_id, season, episode, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_ep ON reactions(tmdb_id, season, episode);

  CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 10),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tmdb_id, season, episode, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_ratings_ep ON ratings(tmdb_id, season, episode);
`);

// --- Helpers ---
const epKey = (req) => ({
  tmdbId: parseInt(req.params.tmdbId, 10),
  season: parseInt(req.params.season, 10),
  episode: parseInt(req.params.episode, 10),
});

const validEp = ({ tmdbId, season, episode }) =>
  Number.isInteger(tmdbId) && Number.isInteger(season) && Number.isInteger(episode);

// --- Health ---
app.get('/health', (req, res) => res.json({ ok: true, service: 'showtrack-community-api' }));

// --- Comments ---
app.get('/api/episodes/:tmdbId/:season/:episode/comments', (req, res) => {
  const k = epKey(req);
  if (!validEp(k)) return res.status(400).json({ error: 'invalid episode key' });
  const rows = db.prepare(
    `SELECT id, user_id AS userId, user_name AS userName, text, created_at AS createdAt
     FROM comments WHERE tmdb_id = ? AND season = ? AND episode = ?
     ORDER BY created_at DESC LIMIT 100`
  ).all(k.tmdbId, k.season, k.episode);
  res.json({ comments: rows });
});

app.post('/api/episodes/:tmdbId/:season/:episode/comments', (req, res) => {
  const k = epKey(req);
  if (!validEp(k)) return res.status(400).json({ error: 'invalid episode key' });
  const { userId, userName, text } = req.body || {};
  if (!userId || !userName || !text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'userId, userName, and non-empty text required' });
  }
  if (text.length > 1000) return res.status(400).json({ error: 'comment too long (max 1000 chars)' });
  const info = db.prepare(
    `INSERT INTO comments (tmdb_id, season, episode, user_id, user_name, text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(k.tmdbId, k.season, k.episode, String(userId), String(userName).slice(0, 50), text.trim());
  res.status(201).json({ id: info.lastInsertRowid });
});

// --- Reactions ---
const ALLOWED_EMOJI = ['❤️', '😂', '😮', '😢', '🔥', '👏'];

app.get('/api/episodes/:tmdbId/:season/:episode/reactions', (req, res) => {
  const k = epKey(req);
  if (!validEp(k)) return res.status(400).json({ error: 'invalid episode key' });
  const { userId } = req.query;
  const counts = db.prepare(
    `SELECT emoji, COUNT(*) AS count FROM reactions
     WHERE tmdb_id = ? AND season = ? AND episode = ? GROUP BY emoji`
  ).all(k.tmdbId, k.season, k.episode);
  let mine = [];
  if (userId) {
    mine = db.prepare(
      `SELECT emoji FROM reactions WHERE tmdb_id = ? AND season = ? AND episode = ? AND user_id = ?`
    ).all(k.tmdbId, k.season, k.episode, String(userId)).map((r) => r.emoji);
  }
  res.json({ counts, mine });
});

app.post('/api/episodes/:tmdbId/:season/:episode/reactions', (req, res) => {
  const k = epKey(req);
  if (!validEp(k)) return res.status(400).json({ error: 'invalid episode key' });
  const { userId, emoji } = req.body || {};
  if (!userId || !emoji || !ALLOWED_EMOJI.includes(emoji)) {
    return res.status(400).json({ error: 'userId and valid emoji required' });
  }
  // Toggle: if exists, remove; else add
  const existing = db.prepare(
    `SELECT id FROM reactions WHERE tmdb_id = ? AND season = ? AND episode = ? AND user_id = ? AND emoji = ?`
  ).get(k.tmdbId, k.season, k.episode, String(userId), emoji);
  if (existing) {
    db.prepare(`DELETE FROM reactions WHERE id = ?`).run(existing.id);
    return res.json({ toggled: 'removed' });
  }
  db.prepare(
    `INSERT INTO reactions (tmdb_id, season, episode, user_id, emoji) VALUES (?, ?, ?, ?, ?)`
  ).run(k.tmdbId, k.season, k.episode, String(userId), emoji);
  res.status(201).json({ toggled: 'added' });
});

// --- Ratings ---
app.get('/api/episodes/:tmdbId/:season/:episode/ratings', (req, res) => {
  const k = epKey(req);
  if (!validEp(k)) return res.status(400).json({ error: 'invalid episode key' });
  const { userId } = req.query;
  const agg = db.prepare(
    `SELECT COUNT(*) AS count, AVG(rating) AS average FROM ratings
     WHERE tmdb_id = ? AND season = ? AND episode = ?`
  ).get(k.tmdbId, k.season, k.episode);
  const dist = db.prepare(
    `SELECT rating, COUNT(*) AS count FROM ratings
     WHERE tmdb_id = ? AND season = ? AND episode = ? GROUP BY rating ORDER BY rating`
  ).all(k.tmdbId, k.season, k.episode);
  let mine = null;
  if (userId) {
    const row = db.prepare(
      `SELECT rating FROM ratings WHERE tmdb_id = ? AND season = ? AND episode = ? AND user_id = ?`
    ).get(k.tmdbId, k.season, k.episode, String(userId));
    mine = row ? row.rating : null;
  }
  res.json({
    count: agg.count,
    average: agg.average ? Math.round(agg.average * 10) / 10 : null,
    distribution: dist,
    mine,
  });
});

app.post('/api/episodes/:tmdbId/:season/:episode/ratings', (req, res) => {
  const k = epKey(req);
  if (!validEp(k)) return res.status(400).json({ error: 'invalid episode key' });
  const { userId, rating } = req.body || {};
  const r = parseInt(rating, 10);
  if (!userId || !Number.isInteger(r) || r < 1 || r > 10) {
    return res.status(400).json({ error: 'userId and rating 1-10 required' });
  }
  db.prepare(
    `INSERT INTO ratings (tmdb_id, season, episode, user_id, rating)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tmdb_id, season, episode, user_id) DO UPDATE SET rating = excluded.rating, created_at = datetime('now')`
  ).run(k.tmdbId, k.season, k.episode, String(userId), r);
  res.status(201).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Static TV Community API listening on port ${PORT}`);
});
