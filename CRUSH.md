# L4 Development Memory

## Commands

```bash
bun install
bun run dev          # Start local dev server with --watch
bun start            # Run src/index.ts
```

## Project Structure

- `/src/index.ts` - Bun.serve() with all routes
- `/src/slack.ts` - Slack Events API handler
- `/src/images.ts` - S3/R2 client (Bun.S3Client) and sharp optimization
- `/src/stats.ts` - SQLite hit stats (bun:sqlite, WAL mode, migrations in /migrations)
- `/src/dashboard.html` - Stats dashboard

## What It Does

Slack-driven image CDN on Bun:
- Uploads files posted in Slack to R2 (via S3-compatible API)
- Converts to WebP (quality 85, sharp) unless told to preserve the format
- Replies in thread with public URLs, reacts with emoji for status
- Supports in-thread "delete" and replace-by-reply flows (original poster or ADMIN_USERS)
- Purges Cloudflare cache after deletes and replacements (5s delay for R2 propagation)
- Direct API uploads with bearer token
- Records per-image hit stats in SQLite (10min/hourly/daily buckets), served via stats API and dashboard

## Endpoints

### Public
- `GET /` - Text banner; redirects browsers (Accept: text/html) to `/dashboard`
- `GET /i/:key` - Records a hit, 307 redirects to R2 object. No transform params.
- `GET /health` - `{ "status": "ok" }`
- `GET /dashboard` - Stats dashboard page

### Stats API (JSON, `days` clamped 1-365)
- `GET /api/stats/overview?days=7` - totalHits, uniqueImages, topImages (max 20)
- `GET /api/stats/traffic?days=7` - time series; granularity 10min (<=1d), hourly (<=30d), daily (>30d); or pass `start`/`end` unix seconds
- `GET /api/stats/image/:key?days=30` - hourly hits for one image

### Slack
- `POST /slack/events` - Slack Events API
  - Verifies X-Slack-Signature (HMAC-SHA256, 5min timestamp window)
  - Top-level file post: downloads, optimizes, uploads, replies in thread
  - Message text containing "preserve" or "png" keeps the original format
  - Thread reply "delete": deletes R2 objects + stats, purges cache, strikes through URLs
  - Thread reply with files: overwrites existing keys in R2, purges cache
  - Delete/replace restricted to original poster or ADMIN_USERS; others get :no_entry:

### API (requires `Authorization: Bearer <AUTH_TOKEN>`)
- `POST /upload` - multipart form-data
  - `file` (required) - the image
  - `preserveFormat` (optional) - "true" to skip WebP conversion
  - Returns `{"success": true, "url": "https://.../i/xxx.webp"}`
  - SVG always passes through unoptimized
  - Key format: nanoid(12) + extension from content type

## Environment Variables

- `PUBLIC_URL` - Public URL of the service (default http://localhost:3000)
- `PORT` - Listen port (default 3000)
- `R2_PUBLIC_URL` - Public base URL of the R2 bucket; `/i/:key` redirects here
- `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` - R2 credentials (AWS_* fallbacks also read)
- `AUTH_TOKEN` - Bearer token for /upload
- `SLACK_BOT_TOKEN` - Slack bot user OAuth token
- `SLACK_SIGNING_SECRET` - Slack app signing secret
- `ALLOWED_CHANNELS` - Comma-separated channel IDs; empty allows all
- `ADMIN_USERS` - Comma-separated Slack user IDs allowed to delete/replace any image
- `CF_ZONE_ID` / `CF_API_TOKEN` - Cloudflare zone for cache purging
- `STATS_DB_PATH` - SQLite path (default ./data/stats.db)
- `NODE_ENV=dev` - Enables Bun development mode (HMR)

## Storage

- Images: R2 bucket via Bun.S3Client (default bucket `l4-images`)
- Stats: bun:sqlite with WAL, migrated by bun-sqlite-migrations from /migrations
- Three bucket tables: 10min (24h retention, cleaned inline), hourly, daily

## Slack Setup

1. Create Slack app at api.slack.com/apps
2. Enable Event Subscriptions, set URL to `https://l4.dunkirk.sh/slack/events`
3. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`, `message.mpim`
4. Add OAuth scopes: `files:read`, `reactions:write`, `chat:write`
5. Install app to workspace, set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`

## Usage Examples

```bash
# API upload
curl -X POST https://l4.dunkirk.sh/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@image.jpg"

# API upload, keep original format
curl -X POST https://l4.dunkirk.sh/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@image.png" \
  -F "preserveFormat=true"

# Slack: post a file where the bot is invited.
# Reply "delete" in the thread to remove it.
# Reply with new files in the thread to replace it.
```

## Emoji Reactions

- `:spinny_fox:` - Upload in progress
- `:yay-still:` - Success
- `:rac-concern:` - Failure
- `:no_entry:` - Unauthorized delete/replace attempt
- `:boomparrot:` - Added to thread parent on delete
