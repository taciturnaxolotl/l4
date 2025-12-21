import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getMigrations, migrate } from "bun-sqlite-migrations";

const DB_PATH = process.env.STATS_DB_PATH || "./data/stats.db";

const dbDir = dirname(DB_PATH);
if (!existsSync(dbDir)) {
	mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL"); // Safe with WAL, faster than FULL
db.exec("PRAGMA busy_timeout = 5000");

// Run migrations
migrate(db, getMigrations("./migrations"));

const increment10MinStmt = db.prepare(`
  INSERT INTO image_stats_10min (image_key, bucket_10min, hits)
  VALUES (?1, ?2, 1)
  ON CONFLICT(image_key, bucket_10min) DO UPDATE SET hits = hits + 1
`);

const incrementHourStmt = db.prepare(`
  INSERT INTO image_stats (image_key, bucket_hour, hits)
  VALUES (?1, ?2, 1)
  ON CONFLICT(image_key, bucket_hour) DO UPDATE SET hits = hits + 1
`);

const incrementDayStmt = db.prepare(`
  INSERT INTO image_stats_daily (image_key, bucket_day, hits)
  VALUES (?1, ?2, 1)
  ON CONFLICT(image_key, bucket_day) DO UPDATE SET hits = hits + 1
`);

// Delete old 10-minute data (older than 24 hours)
const cleanup10MinStmt = db.prepare(`
  DELETE FROM image_stats_10min WHERE bucket_10min < ?
`);

// Track last cleanup time
let lastCleanup = 0;

export function recordHit(imageKey: string): void {
	const now = Math.floor(Date.now() / 1000);
	const bucket10Min = now - (now % 600); // 10 minutes = 600 seconds
	const bucketHour = now - (now % 3600); // 1 hour = 3600 seconds
	const bucketDay = now - (now % 86400); // 1 day = 86400 seconds

	// Write to all three tables
	increment10MinStmt.run(imageKey, bucket10Min);
	incrementHourStmt.run(imageKey, bucketHour);
	incrementDayStmt.run(imageKey, bucketDay);

	// Clean up old 10-minute data every 10 minutes
	if (now - lastCleanup >= 600) {
		const dayAgo = now - 86400;
		const cleanupBucket = dayAgo - (dayAgo % 600);

		// Delete 10-minute data older than 24 hours
		cleanup10MinStmt.run(cleanupBucket);

		lastCleanup = now;
	}
}

export function getStats(imageKey: string, sinceDays: number = 30) {
	const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
	return db
		.prepare(
			`SELECT bucket_hour, hits FROM image_stats 
       WHERE image_key = ? AND bucket_hour >= ? 
       ORDER BY bucket_hour`,
		)
		.all(imageKey, since);
}

export function getTopImages(sinceDays: number = 7, limit: number = 10) {
	const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;

	// Combine data from both hourly and 10-minute tables
	return db
		.prepare(
			`SELECT image_key, SUM(hits) as total FROM (
         SELECT image_key, hits FROM image_stats WHERE bucket_hour >= ?
         UNION ALL
         SELECT image_key, hits FROM image_stats_10min WHERE bucket_10min >= ?
       ) 
       GROUP BY image_key ORDER BY total DESC LIMIT ?`,
		)
		.all(since, since, limit);
}

export function getTotalHits(sinceDays: number = 30) {
	const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
	const result = db
		.prepare(
			`SELECT SUM(hits) as total FROM image_stats WHERE bucket_hour >= ?`,
		)
		.get(since) as { total: number | null };
	return result?.total ?? 0;
}

export function getUniqueImages(sinceDays: number = 30) {
	const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
	const result = db
		.prepare(
			`SELECT COUNT(DISTINCT image_key) as count FROM image_stats WHERE bucket_hour >= ?`,
		)
		.get(since) as { count: number | null };
	return result?.count ?? 0;
}

export function getHourlyTraffic(sinceDays: number = 7) {
	const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
	return db
		.prepare(
			`SELECT bucket_hour, SUM(hits) as hits 
       FROM image_stats WHERE bucket_hour >= ? 
       GROUP BY bucket_hour ORDER BY bucket_hour`,
		)
		.all(since) as { bucket_hour: number; hits: number }[];
}

export function getDailyTraffic(sinceDays: number = 30) {
	const since = Math.floor(Date.now() / 1000) - sinceDays * 86400;
	return db
		.prepare(
			`SELECT (bucket_hour / 86400) * 86400 as bucket_day, SUM(hits) as hits 
       FROM image_stats WHERE bucket_hour >= ? 
       GROUP BY bucket_day ORDER BY bucket_day`,
		)
		.all(since) as { bucket_day: number; hits: number }[];
}

export function getTraffic(
	sinceDays: number = 7,
	options?: { startTime?: number; endTime?: number },
) {
	const now = Math.floor(Date.now() / 1000);
	const since = options?.startTime ?? now - sinceDays * 86400;
	const end = options?.endTime ?? now;

	const spanSeconds = end - since;
	const spanDays = spanSeconds / 86400;

	// <= 1 day: 10min data if available
	if (spanDays <= 1) {
		const data = db
			.prepare(
				`SELECT bucket_10min as bucket, SUM(hits) as hits 
         FROM image_stats_10min WHERE bucket_10min >= ? AND bucket_10min <= ?
         GROUP BY bucket_10min ORDER BY bucket_10min`,
			)
			.all(since, end) as { bucket: number; hits: number }[];

		if (data.length > 0) {
			return { granularity: "10min", data };
		}
	}

	// 1-30 days: always hourly
	if (spanDays <= 30) {
		const data = db
			.prepare(
				`SELECT bucket_hour as bucket, SUM(hits) as hits
         FROM image_stats WHERE bucket_hour >= ? AND bucket_hour <= ?
         GROUP BY bucket_hour ORDER BY bucket_hour`,
			)
			.all(since, end) as { bucket: number; hits: number }[];

		return { granularity: "hourly", data };
	}

	// > 30 days: daily
	const data = db
		.prepare(
			`SELECT bucket_day as bucket, SUM(hits) as hits 
       FROM image_stats_daily WHERE bucket_day >= ? AND bucket_day <= ?
       GROUP BY bucket_day ORDER BY bucket_day`,
		)
		.all(since, end) as { bucket: number; hits: number }[];

	return { granularity: "daily", data };
}
