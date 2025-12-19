# The L4 cache

This is my own image cdn built on cloudflare r2 mainly so I can have fast optimized images on my blog.

## Docs

```bash
bun install
wrangler r2 bucket create l4-images
wrangler kv namespace create L4
```

Update `wrangler.toml` with the KV namespace ID and set `HOST` to your domain as well as `INDIKO_URL` to your Indiko instance

### Production

```bash
wrangler secret put INDIKO_CLIENT_ID
wrangler secret put INDIKO_CLIENT_SECRET
```

```bash
bun run deploy
```

## Development

```bash
bun run dev
```

Create `.dev.vars` for local development:

```env
INDIKO_CLIENT_ID=your_client_id
INDIKO_CLIENT_SECRET=your_client_secret
```

## CLI Usage

### Install CLI

```bash
cd cli
bun install
bun run build
npm link
```

### Configure

```bash
l4 config --api-key <your-api-key> --url https://l4.yourdomain.com
```

### Upload Image

```bash
l4 upload image.jpg
l4 upload image.jpg --key custom-name.jpg
```

### List Images

```bash
l4 list
l4 list --limit 50
```

### Delete Image

```bash
l4 delete image-key.jpg
```

### Get Image URL

```bash
l4 url image.jpg
l4 url image.jpg --width 800 --format webp --quality 85
```

## Image Transformations

Images are served via `/i/:key` with optional query parameters:

- `w` - Width (pixels)
- `h` - Height (pixels)
- `f` - Format (`auto`, `webp`, `avif`, `jpeg`)
- `q` - Quality (1-100, default 85)
- `fit` - Fit mode (`scale-down`, `contain`, `cover`, `crop`, `pad`)

### Examples

```
/i/photo.jpg?w=800&f=webp
/i/photo.jpg?w=400&h=400&fit=cover&q=90
/i/photo.jpg?f=auto
```

## API Endpoints

### Authentication

- `GET /login` - Login page
- `GET /api/login` - Initiate OAuth
- `GET /api/callback` - OAuth callback
- `POST /api/logout` - Logout
- `GET /api/me` - Get current user

### Images

- `POST /api/upload` - Upload image (multipart/form-data)
- `GET /api/images` - List images
- `DELETE /api/images/:key` - Delete image
- `GET /i/:key` - Serve image (public)

### API Keys

- `GET /api/keys` - List API keys
- `POST /api/keys` - Create API key
- `DELETE /api/keys/:id` - Delete API key

## Architecture

```
┌─────────────┐
│   Browser   │
└──────┬──────┘
       │
       ├─── HTML/JS (Indiko OAuth)
       │
       ├─── Upload/Manage Images
       │
       v
┌─────────────────┐
│ Cloudflare      │
│ Workers         │
│                 │
│ - Auth          │
│ - Transform     │
│ - Cache         │
└────────┬────────┘
         │
         ├─── Session/Metadata
         v
    ┌────────┐
    │   KV   │
    └────────┘
         │
         ├─── Original Images
         v
    ┌────────┐
    │   R2   │
    └────────┘
```

<p align="center">
    <img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/main/.github/images/line-break.svg" />
</p>

<p align="center">
    <i><code>&copy 2025-present <a href="https://dunkirk.sh">Kieran Klukas</a></code></i>
</p>

<p align="center">
    <a href="https://tangled.org/dunkirk.sh/l4/blob/main/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=O'Saasy&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
