-- Add daily granularity table for long time ranges (30+ days)
-- This significantly improves query performance by reducing rows scanned
CREATE TABLE IF NOT EXISTS image_stats_daily (
  image_key TEXT NOT NULL,
  bucket_day INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (image_key, bucket_day)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_stats_daily_time 
ON image_stats_daily(bucket_day, image_key);

CREATE INDEX IF NOT EXISTS idx_stats_daily_traffic 
ON image_stats_daily(bucket_day, hits);
