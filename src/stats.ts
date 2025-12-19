import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.STATS_DB_PATH || "./data/stats.db";

const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL"); // Safe with WAL, faster than FULL
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS image_stats (
    image_key TEXT NOT NULL,
    bucket_hour INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (image_key, bucket_hour)
  ) WITHOUT ROWID
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_stats_time 
  ON image_stats(bucket_hour, image_key)
`);

const incrementStmt = db.prepare(`
  INSERT INTO image_stats (image_key, bucket_hour, hits)
  VALUES (?1, ?2, 1)
  ON CONFLICT(image_key, bucket_hour) DO UPDATE SET hits = hits + 1
`);

export function recordHit(imageKey: string): void {
  const now = Math.floor(Date.now() / 1000);
  const bucketHour = now - (now % 3600);
  incrementStmt.run(imageKey, bucketHour);
}

export function getStats(imageKey: string, sinceDays: number = 30) {
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  return db
    .prepare(
      `SELECT bucket_hour, hits FROM image_stats 
       WHERE image_key = ? AND bucket_hour >= ? 
       ORDER BY bucket_hour`
    )
    .all(imageKey, since);
}

export function getTopImages(sinceDays: number = 7, limit: number = 10) {
  const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
  return db
    .prepare(
      `SELECT image_key, SUM(hits) as total 
       FROM image_stats WHERE bucket_hour >= ? 
       GROUP BY image_key ORDER BY total DESC LIMIT ?`
    )
    .all(since, limit);
}
