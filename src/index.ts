import sharp from "sharp";
import { nanoid } from "nanoid";

// R2 configuration from env
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET = process.env.R2_BUCKET || "l4-images";
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;
const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";

// Slack configuration
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;
const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNELS?.split(",").map(c => c.trim()) || [];

// Create S3 client for R2
const s3 = new Bun.S3Client({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  bucket: R2_BUCKET,
  endpoint: R2_ENDPOINT,
});

async function optimizeImage(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
  // Skip SVGs - just return as-is
  if (mimeType === "image/svg+xml") {
    return { buffer, contentType: mimeType, extension: "svg" };
  }

  // Convert to WebP with optimization (effort 4 = balanced speed/compression)
  const optimized = await sharp(buffer)
    .webp({ quality: 85, effort: 4 }) // effort: 0-6, 4 is faster than 6 with minimal quality loss
    .toBuffer();

  return { buffer: optimized, contentType: "image/webp", extension: "webp" };
}

async function uploadImageToR2(buffer: Buffer, contentType: string): Promise<string> {
  // Skip collision check - nanoid(12) has 4.7 quadrillion possibilities, collision is astronomically unlikely
  const extension = contentType === "image/svg+xml" ? "svg" : "webp";
  const imageKey = `${nanoid(12)}.${extension}`;

  // Upload to R2
  await s3.file(imageKey).write(buffer, { type: contentType });

  return imageKey;
}

// HTTP server for Slack events
const server = Bun.serve({
  port: process.env.PORT || 3000,
  
  routes: {
    "/slack/events": {
      async POST(request) {
        return handleSlackEvent(request);
      },
    },
    
    "/health": {
      async GET(request) {
        return new Response("OK", { status: 200 });
      },
    },
    
    "/i/:key": {
      async GET(request) {
        const imageKey = request.params.key;
        if (!imageKey) {
          return new Response("Not found", { status: 404 });
        }

        // Skip exists check - redirect directly, R2 will handle 404s
        // This saves ~50-100ms per request
        const r2PublicUrl = `${R2_PUBLIC_URL}/${imageKey}`;
        return Response.redirect(r2PublicUrl, 307);
      },
    },
  },
  
  // Fallback for unmatched routes
  async fetch(request) {
    return new Response("Not found", { status: 404 });
  },
});

async function handleSlackEvent(request: Request) {
  try {
    const body = await request.text();
    const payload = JSON.parse(body);

    // URL verification challenge
    if (payload.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle file message events
    if (payload.type === "event_callback" && payload.event?.type === "message") {
      const event = payload.event;

      // Check for files
      if (!event.files || event.files.length === 0) {
        return new Response("OK", { status: 200 });
      }

      // Check if channel is allowed
      if (ALLOWED_CHANNELS.length > 0 && !ALLOWED_CHANNELS.includes(event.channel)) {
        return new Response("OK", { status: 200 });
      }

      // Process files in background (don't await - return 200 immediately)
      processSlackFiles(event).catch(console.error);

      return new Response("OK", { status: 200 });
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Error handling Slack event:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

async function processSlackFiles(event: any) {
  try {
    // React with loading emoji (don't await - do it in parallel with downloads)
    const loadingReaction = callSlackAPI("reactions.add", {
      channel: event.channel,
      timestamp: event.ts,
      name: "spinny_fox",
    });

    // Process all files in parallel
    const filePromises = event.files.map(async (file: any) => {
      try {
        console.log(`Processing file: ${file.name}`);

        // Download file from Slack
        const fileResponse = await fetch(file.url_private, {
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          },
        });

        if (!fileResponse.ok) {
          throw new Error("Failed to download file from Slack");
        }

        const originalBuffer = Buffer.from(await fileResponse.arrayBuffer());
        const contentType = file.mimetype || "image/jpeg";

        console.log(`Downloaded ${file.name} (${originalBuffer.length} bytes)`);

        // Optimize image
        const { buffer: optimizedBuffer, contentType: newContentType } = await optimizeImage(originalBuffer, contentType);

        const savings = ((1 - optimizedBuffer.length / originalBuffer.length) * 100).toFixed(1);
        console.log(`Optimized: ${originalBuffer.length} → ${optimizedBuffer.length} bytes (${savings}% reduction)`);

        // Upload to R2
        const imageKey = await uploadImageToR2(optimizedBuffer, newContentType);
        console.log(`Uploaded to R2: ${imageKey}`);

        return `${PUBLIC_URL}/i/${imageKey}`;
      } catch (error) {
        console.error(`Error processing file ${file.name}:`, error);
        return null;
      }
    });

    // Wait for all files to complete
    const results = await Promise.all(filePromises);
    const urls = results.filter((url): url is string => url !== null);

    // Ensure loading reaction is done
    await loadingReaction;

    // Do all Slack API calls in parallel
    const apiCalls: Promise<any>[] = [
      // Remove loading reaction
      callSlackAPI("reactions.remove", {
        channel: event.channel,
        timestamp: event.ts,
        name: "spinny_fox",
      }),
    ];

    if (urls.length > 0) {
      apiCalls.push(
        // Add success reaction
        callSlackAPI("reactions.add", {
          channel: event.channel,
          timestamp: event.ts,
          name: "good_move",
        }),
        // Post URLs in thread
        callSlackAPI("chat.postMessage", {
          channel: event.channel,
          thread_ts: event.ts,
          text: urls.join("\n"),
        })
      );
    } else {
      apiCalls.push(
        // Add error reaction
        callSlackAPI("reactions.add", {
          channel: event.channel,
          timestamp: event.ts,
          name: "rac-concern",
        })
      );
    }

    await Promise.all(apiCalls);
  } catch (error) {
    console.error("Error processing Slack files:", error);

    // Add error reaction
    await callSlackAPI("reactions.add", {
      channel: event.channel,
      timestamp: event.ts,
      name: "rac-concern",
    }).catch(console.error);
  }
}

async function callSlackAPI(method: string, params: any) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(params),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data;
}

console.log(`L4 Image CDN started on port ${server.port}`);
console.log(`- R2 Bucket: ${R2_BUCKET}`);
console.log(`- R2 Public URL: ${R2_PUBLIC_URL}`);
console.log(`- Public URL: ${PUBLIC_URL}`);
console.log(`- Slack events: ${PUBLIC_URL}/slack/events`);
