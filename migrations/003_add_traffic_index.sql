-- Add covering index for traffic queries to enable index-only scans
-- This significantly improves performance for long time ranges by avoiding table lookups
CREATE INDEX IF NOT EXISTS idx_stats_traffic 
ON image_stats(bucket_hour, hits);
