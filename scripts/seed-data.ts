import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";

const DB_PATH = process.env.STATS_DB_PATH || "./data/stats.db";
const db = new Database(DB_PATH, { create: true });

// Generate realistic fake data
const imageKeys: string[] = [];
const numImages = 50;

// Generate fake image keys
for (let i = 0; i < numImages; i++) {
  imageKeys.push(`${nanoid(12)}.webp`);
}

const now = Math.floor(Date.now() / 1000);
const thirtyDaysAgo = now - 30 * 86400;

console.log("Seeding database with fake data over last 30 days...");

const stmt = db.prepare(`
  INSERT INTO image_stats (image_key, bucket_hour, hits)
  VALUES (?1, ?2, ?3)
  ON CONFLICT(image_key, bucket_hour) DO UPDATE SET hits = hits + ?3
`);

// Generate data for each hour in the last 30 days
for (let timestamp = thirtyDaysAgo; timestamp <= now; timestamp += 3600) {
  const bucketHour = timestamp - (timestamp % 3600);
  
  // Randomly select images to have hits this hour
  // More recent hours get more activity
  const recency = (timestamp - thirtyDaysAgo) / (now - thirtyDaysAgo);
  const baseActivity = 0.3 + recency * 0.4; // 30-70% chance base
  
  // Add weekly pattern (weekdays busier)
  const date = new Date(timestamp * 1000);
  const dayOfWeek = date.getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const weekdayMultiplier = isWeekend ? 0.6 : 1.2;
  
  // Add hourly pattern (business hours busier)
  const hour = date.getUTCHours();
  const isBusinessHours = hour >= 9 && hour <= 17;
  const hourMultiplier = isBusinessHours ? 1.5 : 0.5;
  
  const activityChance = baseActivity * weekdayMultiplier * hourMultiplier;
  
  for (const imageKey of imageKeys) {
    // Each image has a random popularity factor
    const popularity = Math.random();
    
    if (Math.random() < activityChance * popularity) {
      // Exponential distribution for hit counts (most have few hits, some have many)
      const hits = Math.max(1, Math.floor(Math.random() ** 2 * 100));
      stmt.run(imageKey, bucketHour, hits);
    }
  }
}

// Get summary stats
const totalHits = db.prepare(`SELECT SUM(hits) as total FROM image_stats`).get() as { total: number };
const uniqueImages = db.prepare(`SELECT COUNT(DISTINCT image_key) as count FROM image_stats`).get() as { count: number };
const hourBuckets = db.prepare(`SELECT COUNT(DISTINCT bucket_hour) as count FROM image_stats`).get() as { count: number };

console.log("\nSeeding complete!");
console.log(`- Total hits: ${totalHits.total.toLocaleString()}`);
console.log(`- Unique images: ${uniqueImages.count}`);
console.log(`- Hour buckets: ${hourBuckets.count}`);
console.log(`- Time range: ${new Date(thirtyDaysAgo * 1000).toISOString()} to ${new Date(now * 1000).toISOString()}`);
