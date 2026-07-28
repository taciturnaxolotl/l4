# The L4 cache

![screenshot](https://l4.dunkirk.sh/i/_4FmH-ItogOD.webp)

This is my own image cdn built on cloudflare r2 mainly so I can have fast optimized images on my blog.

## Docs

Create `.env`:

```env
SLACK_BOT_TOKEN=token
SLACK_SIGNING_SECRET=secret
AUTH_TOKEN=token
```

```bash
bun install
bun start
```

## API

### `POST /upload`

Uploads an image. Requires the header `Authorization: Bearer <AUTH_TOKEN>`.

The request body is multipart form-data with these fields:

- `file` (required): the image file.
- `preserveFormat` (optional): if `"true"`, keep the original format. Otherwise the server converts the image to WebP at quality 85. SVG files are always kept as-is.

Returns JSON:

```json
{ "success": true, "url": "https://l4.dunkirk.sh/i/abc123def456.webp" }
```

Errors: `401` without a valid token, `400` if the `file` field is missing, `500` on upload failure.

The file name is a random 12-character id plus an extension that matches the stored content type.

### `GET /i/:key`

Fetches an image. Records a hit in the stats database, then returns a `307` redirect to the object in R2. Returns `404` if the key is empty.

### `GET /health`

Returns `{ "status": "ok" }`.

### Stats API

All stats endpoints return JSON. Time buckets are Unix timestamps in seconds. The `days` parameter is clamped to the range 1 to 365.

#### `GET /api/stats/overview?days=7`

Returns totals for the period:

```json
{
  "totalHits": 1234,
  "uniqueImages": 56,
  "topImages": [{ "image_key": "abc123def456.webp", "total": 100 }]
}
```

`topImages` lists at most 20 images, sorted by hit count.

#### `GET /api/stats/traffic?days=7`

Returns hits over time:

```json
{
  "granularity": "hourly",
  "data": [{ "bucket": 1753000000, "hits": 42 }]
}
```

The granularity depends on the time span: `10min` for up to 1 day, `hourly` for up to 30 days, `daily` above that. You can also pass `start` and `end` (Unix seconds) instead of `days`.

#### `GET /api/stats/image/:key?days=30`

Returns hourly hits for one image:

```json
[{ "bucket_hour": 1753000000, "hits": 42 }]
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
