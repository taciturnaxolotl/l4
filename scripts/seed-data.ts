import { Database } from "bun:sqlite";
import { nanoid } from "nanoid";

const DB_PATH = process.env.STATS_DB_PATH || "./data/stats.db";
const db = new Database(DB_PATH, { create: true });

// Generate realistic fake data
const imageKeys: string[] = [];
const numImages = 500; // More images for variety

// Generate fake image keys with varying introduction dates
const now = Math.floor(Date.now() / 1000);
const oneYearAgo = now - 365 * 86400;
const thirtyDaysAgo = now - 30 * 86400;
const oneDayAgo = now - 86400;

interface Image {
  key: string;
  introducedAt: number; // When this image first appeared
  basePopularity: number; // Intrinsic popularity (0-1)
  trendFactor: number; // How much popularity changes over time (-0.5 to 0.5)
  viralPeak?: number; // Optional viral spike timestamp
}

const images: Image[] = [];

// Create images with staggered introduction dates
for (let i = 0; i < numImages; i++) {
  const introDate = oneYearAgo + Math.random() * (now - oneYearAgo);
  const basePopularity = Math.random() ** 1.5; // Skew toward lower popularity
  const trendFactor = (Math.random() - 0.5) * 0.8; // -0.4 to 0.4
  
  const image: Image = {
    key: `${nanoid(12)}.webp`,
    introducedAt: introDate,
    basePopularity,
    trendFactor,
  };
  
  // 10% chance of having a viral spike
  if (Math.random() < 0.1) {
    image.viralPeak = introDate + Math.random() * (now - introDate);
  }
  
  images.push(image);
}

console.log("Seeding database with fake data (1 year)...");

// Seed hourly data for older than 24 hours
const hourlyStmt = db.prepare(`
  INSERT INTO image_stats (image_key, bucket_hour, hits)
  VALUES (?1, ?2, ?3)
  ON CONFLICT(image_key, bucket_hour) DO UPDATE SET hits = hits + ?3
`);

console.log("Seeding hourly data (1 year ago to 24 hours ago)...");
let totalHourlyHits = 0;

for (let timestamp = oneYearAgo; timestamp < oneDayAgo; timestamp += 3600) {
  const bucketHour = timestamp - (timestamp % 3600);
  
  // Time-based factors
  const date = new Date(timestamp * 1000);
  const dayOfWeek = date.getUTCDay();
  const hour = date.getUTCHours();
  const month = date.getUTCMonth();
  
  // Weekly pattern (weekdays busier)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const weekdayMultiplier = isWeekend ? 0.6 : 1.0;
  
  // Daily pattern (business hours busier, with some randomness)
  const isBusinessHours = hour >= 9 && hour <= 17;
  const hourMultiplier = isBusinessHours 
    ? 1.2 + Math.random() * 0.4  // 1.2-1.6
    : 0.4 + Math.random() * 0.3; // 0.4-0.7
  
  // Seasonal pattern (summer busier)
  const isSummer = month >= 5 && month <= 8; // June-Sept
  const seasonalMultiplier = isSummer ? 1.3 : 0.9;
  
  // Overall growth trend (traffic increases over time)
  const timeProgress = (timestamp - oneYearAgo) / (now - oneYearAgo);
  const growthMultiplier = 0.7 + (timeProgress * 0.6); // 0.7 to 1.3
  
  // Random noise to break perfect cycles
  const noiseMultiplier = 0.85 + Math.random() * 0.3; // 0.85-1.15
  
  const baseActivity = 0.25 * weekdayMultiplier * hourMultiplier * seasonalMultiplier * growthMultiplier * noiseMultiplier;
  
  for (const image of images) {
    // Skip if image doesn't exist yet
    if (timestamp < image.introducedAt) continue;
    
    // Calculate image-specific popularity at this time
    const timeSinceIntro = timestamp - image.introducedAt;
    const ageInDays = timeSinceIntro / 86400;
    
    // Popularity changes over time (trend factor)
    const trendProgress = Math.min(ageInDays / 180, 1); // Over 6 months
    const trendedPopularity = image.basePopularity + (image.trendFactor * trendProgress);
    
    // Viral spike (if any)
    let viralBoost = 1;
    if (image.viralPeak) {
      const distanceFromPeak = Math.abs(timestamp - image.viralPeak);
      const peakWindow = 7 * 86400; // 7 day spike
      if (distanceFromPeak < peakWindow) {
        viralBoost = 1 + (5 * (1 - distanceFromPeak / peakWindow)); // Up to 6x boost
      }
    }
    
    // New images get a temporary boost
    const newImageBoost = ageInDays < 3 ? (1 + (3 - ageInDays) * 0.5) : 1;
    
    const finalPopularity = trendedPopularity * viralBoost * newImageBoost;
    
    if (Math.random() < baseActivity * finalPopularity) {
      // Power law distribution for hit counts (most hits are small, some are large)
      const hits = Math.max(1, Math.floor((Math.random() ** 3) * 200));
      hourlyStmt.run(image.key, bucketHour, hits);
      totalHourlyHits += hits;
    }
  }
  
  // Progress indicator every 30 days
  if ((timestamp - oneYearAgo) % (30 * 86400) === 0) {
    const daysProcessed = Math.floor((timestamp - oneYearAgo) / 86400);
    console.log(`  Processed ${daysProcessed} days...`);
  }
}

// Seed 10-minute data for last 24 hours
const tenMinStmt = db.prepare(`
  INSERT INTO image_stats_10min (image_key, bucket_10min, hits)
  VALUES (?1, ?2, ?3)
  ON CONFLICT(image_key, bucket_10min) DO UPDATE SET hits = hits + ?3
`);

console.log("Seeding 10-minute data (last 24 hours)...");
let total10MinHits = 0;

for (let timestamp = oneDayAgo; timestamp <= now; timestamp += 600) {
  const bucket10Min = timestamp - (timestamp % 600);
  const bucketHour = timestamp - (timestamp % 3600);
  
  // Recent data gets slightly higher activity
  const recency = (timestamp - oneDayAgo) / (now - oneDayAgo);
  const date = new Date(timestamp * 1000);
  const dayOfWeek = date.getUTCDay();
  const hour = date.getUTCHours();
  
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const weekdayMultiplier = isWeekend ? 0.6 : 1.0;
  
  const isBusinessHours = hour >= 9 && hour <= 17;
  const hourMultiplier = isBusinessHours 
    ? 1.3 + Math.random() * 0.4 
    : 0.5 + Math.random() * 0.3;
  
  const noiseMultiplier = 0.85 + Math.random() * 0.3;
  
  const baseActivity = 0.35 * (1 + recency * 0.3) * weekdayMultiplier * hourMultiplier * noiseMultiplier;
  
  for (const image of images) {
    if (timestamp < image.introducedAt) continue;
    
    const timeSinceIntro = timestamp - image.introducedAt;
    const ageInDays = timeSinceIntro / 86400;
    const trendProgress = Math.min(ageInDays / 180, 1);
    const trendedPopularity = image.basePopularity + (image.trendFactor * trendProgress);
    
    let viralBoost = 1;
    if (image.viralPeak) {
      const distanceFromPeak = Math.abs(timestamp - image.viralPeak);
      const peakWindow = 7 * 86400;
      if (distanceFromPeak < peakWindow) {
        viralBoost = 1 + (5 * (1 - distanceFromPeak / peakWindow));
      }
    }
    
    const newImageBoost = ageInDays < 3 ? (1 + (3 - ageInDays) * 0.5) : 1;
    const finalPopularity = trendedPopularity * viralBoost * newImageBoost;
    
    if (Math.random() < baseActivity * finalPopularity) {
      const hits = Math.max(1, Math.floor((Math.random() ** 3) * 100));
      tenMinStmt.run(image.key, bucket10Min, hits);
      hourlyStmt.run(image.key, bucketHour, hits);
      total10MinHits += hits;
    }
  }
}

// Get summary stats
const totalHitsHourly = db.prepare(`SELECT SUM(hits) as total FROM image_stats`).get() as { total: number };
const totalHits10Min = db.prepare(`SELECT SUM(hits) as total FROM image_stats_10min`).get() as { total: number };
const uniqueImages = db.prepare(`
  SELECT COUNT(DISTINCT image_key) as count FROM (
    SELECT image_key FROM image_stats
    UNION
    SELECT image_key FROM image_stats_10min
  )
`).get() as { count: number };
const hourBuckets = db.prepare(`SELECT COUNT(*) as count FROM image_stats`).get() as { count: number };
const tenMinBuckets = db.prepare(`SELECT COUNT(*) as count FROM image_stats_10min`).get() as { count: number };
const oldestHit = db.prepare(`SELECT MIN(bucket_hour) as min FROM image_stats`).get() as { min: number };
const newestHit = db.prepare(`SELECT MAX(bucket_hour) as max FROM image_stats`).get() as { max: number };

console.log("\nSeeding complete!");
console.log(`- Total hits (hourly): ${totalHitsHourly.total.toLocaleString()}`);
console.log(`- Total hits (10-min): ${totalHits10Min.total.toLocaleString()}`);
console.log(`- Unique images: ${uniqueImages.count}`);
console.log(`- Hourly buckets: ${hourBuckets.count.toLocaleString()}`);
console.log(`- 10-minute buckets: ${tenMinBuckets.count.toLocaleString()}`);
console.log(`- Time range: ${new Date(oldestHit.min * 1000).toISOString()} to ${new Date(newestHit.max * 1000).toISOString()}`);
console.log(`- Days of data: ${Math.floor((newestHit.max - oldestHit.min) / 86400)}`);


