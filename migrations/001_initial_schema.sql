-- Initial schema for image stats
CREATE TABLE IF NOT EXISTS image_stats (
  image_key TEXT NOT NULL,
  bucket_hour INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (image_key, bucket_hour)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_stats_time 
ON image_stats(bucket_hour, image_key);
