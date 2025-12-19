-- Add 10-minute granularity table for last 24 hours
CREATE TABLE IF NOT EXISTS image_stats_10min (
  image_key TEXT NOT NULL,
  bucket_10min INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (image_key, bucket_10min)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_stats_10min_time 
ON image_stats_10min(bucket_10min, image_key);
