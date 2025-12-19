# L4 Development Memory

## Commands

### Development
```bash
bun run dev          # Start local development server
bun run deploy       # Deploy to Cloudflare
bun run types        # Generate TypeScript types
```

### Wrangler
```bash
wrangler r2 bucket create l4-images     # Create R2 bucket
wrangler secret put AUTH_TOKEN          # Set auth token for API uploads
wrangler secret put SLACK_BOT_TOKEN     # Set Slack bot token
wrangler secret put SLACK_SIGNING_SECRET # Set Slack signing secret
```

## Project Structure

- `/src/index.ts` - Worker with Slack bot and upload endpoint
- `/wrangler.toml` - Cloudflare Workers configuration
- `/manifest.yaml` - Slack app manifest for easy setup

## What It Does

Slack CDN bot for Cloudflare Workers:
- Automatically uploads files posted in Slack to R2
- Returns public URLs in thread
- Uses custom emoji reactions for status (:spinny_fox: → :good_move: or :rac-concern:)
- Also supports direct API uploads with auth token
- Images served with transformations via Cloudflare's edge

## Endpoints

### Public
- `GET /i/:key?w=800&h=600&f=webp&q=85&fit=scale-down` - Serve image with transformations

### Slack
- `POST /slack/events` - Slack Events API endpoint
  - Listens for `message` events with files
  - Downloads files from Slack
  - Uploads to R2 with random filename
  - Posts URLs in thread

### API (requires `Authorization: Bearer <AUTH_TOKEN>`)
- `POST /upload` - Upload image (multipart form-data with `file` field)
  - Returns: `{"success": true, "url": "https://.../i/xxx.jpg"}`

## Image URL Parameters

- `w` - width
- `h` - height  
- `f` - format (auto, webp, avif, jpeg)
- `q` - quality (1-100)
- `fit` - fit mode (scale-down, contain, cover, crop, pad)

## Environment Variables

Config (wrangler.toml):
- `PUBLIC_URL` - Public URL of the service (e.g., https://l4.dunkirk.sh)

Secrets:
- `AUTH_TOKEN` - Auth token for API uploads
- `SLACK_BOT_TOKEN` - Slack bot user OAuth token
- `SLACK_SIGNING_SECRET` - Slack app signing secret

## Bindings

- `IMAGES` - R2 bucket for image storage

## Slack Setup

### Option 1: Using Manifest (Easy)
1. Go to api.slack.com/apps
2. Click "Create New App" → "From an app manifest"
3. Select your workspace
4. Paste contents of `manifest.yaml`
5. Update the request URL if needed
6. Install app to workspace
7. Copy "Bot User OAuth Token" and "Signing Secret"
8. Set secrets in Workers:
   ```bash
   wrangler secret put SLACK_BOT_TOKEN
   wrangler secret put SLACK_SIGNING_SECRET
   ```

### Option 2: Manual Setup
1. Create Slack app at api.slack.com/apps
2. Enable Event Subscriptions, set URL to `https://l4.dunkirk.sh/slack/events`
3. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`, `message.mpim`
4. Add OAuth scopes: `files:read`, `reactions:write`, `chat:write`
5. Install app to workspace
6. Set secrets in Workers

## Usage Examples

```bash
# API upload
curl -X POST https://l4.dunkirk.sh/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@image.jpg"

# Slack: Just post a file in a channel where the bot is invited
```

## Emoji Reactions

- `:spinny_fox:` - Uploading in progress
- `:good_move:` - Upload succeeded
- `:rac-concern:` - Upload failed
