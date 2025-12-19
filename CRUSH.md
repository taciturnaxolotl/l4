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
wrangler r2 bucket create l4-images               # Create R2 bucket
wrangler kv:namespace create L4                   # Create KV namespace
wrangler secret put INDIKO_CLIENT_ID              # Set secret
wrangler secret put INDIKO_CLIENT_SECRET          # Set secret
```

### CLI
```bash
cd cli && bun install && bun run build           # Build CLI
l4 config --api-key <key> --url <url>            # Configure CLI
l4 upload <file>                                  # Upload image
l4 list                                           # List images
```

## Project Structure

- `/src/index.ts` - Main Worker entry point with auth, image serving, API key management
- `/src/index.html` - Frontend application with upload UI, image grid, API key management
- `/src/login.html` - Login page with Indiko OAuth
- `/cli/` - CLI tool for uploading/managing images
- `/wrangler.toml` - Cloudflare Workers configuration

## Key Features

- **Indiko OAuth**: Session-based auth with admin/viewer roles
- **API Keys**: Generate keys for CLI/programmatic access
- **Image Transformations**: On-demand resize, format conversion (AVIF/WebP), quality adjustment
- **R2 Storage**: Zero egress costs, S3-compatible
- **Edge Caching**: Two-tier cache (Cloudflare edge + browser)
- **Role-based Access**: Viewers can view, admins can upload/delete

## Image URL Pattern

```
/i/:key?w=800&h=600&f=webp&q=85&fit=scale-down
```

Parameters:
- `w` - width
- `h` - height  
- `f` - format (auto, webp, avif, jpeg)
- `q` - quality (1-100)
- `fit` - fit mode (scale-down, contain, cover, crop, pad)

## Environment Variables

Production (secrets):
- `INDIKO_CLIENT_ID` - Indiko OAuth client ID
- `INDIKO_CLIENT_SECRET` - Indiko OAuth client secret

Config (wrangler.toml):
- `HOST` - Public URL of the service
- `INDIKO_URL` - Indiko instance URL

## Bindings

- `L4` - KV namespace for sessions, API keys, image metadata
- `IMAGES` - R2 bucket for image storage
