import { nanoid } from "nanoid";
import sharp from "sharp";
import dashboard from "./dashboard.html";
import {
	deleteImageStats,
	getStats,
	getTopImages,
	getTotalHits,
	getTraffic,
	getUniqueImages,
	recordHit,
} from "./stats";

// Configuration from env
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.AUTH_TOKEN;

// S3 configuration
const S3_ACCESS_KEY_ID =
	process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "";
const S3_SECRET_ACCESS_KEY =
	process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "";
const S3_BUCKET =
	process.env.S3_BUCKET || process.env.AWS_BUCKET || "l4-images";
const S3_ENDPOINT = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT || "";
const S3_REGION = process.env.S3_REGION || process.env.AWS_REGION || "auto";

// Slack configuration
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const _SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const ALLOWED_CHANNELS =
	process.env.ALLOWED_CHANNELS?.split(",").map((c) => c.trim()) || [];
const ADMIN_USERS =
	process.env.ADMIN_USERS?.split(",").map((u) => u.trim()) || [];

// Cloudflare cache purge configuration
const CF_ZONE_ID = process.env.CF_ZONE_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";

// Create S3 client for R2 with explicit configuration
const s3 = new Bun.S3Client({
	accessKeyId: S3_ACCESS_KEY_ID,
	secretAccessKey: S3_SECRET_ACCESS_KEY,
	endpoint: S3_ENDPOINT,
	bucket: S3_BUCKET,
	region: S3_REGION,
});

async function optimizeImage(
	buffer: Buffer,
	mimeType: string,
	preserveFormat = false,
): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
	// Skip SVGs - just return as-is
	if (mimeType === "image/svg+xml") {
		return { buffer, contentType: mimeType, extension: "svg" };
	}

	// If preserveFormat is true, keep original format
	if (preserveFormat) {
		const extension = mimeType.split("/")[1] || "jpg";
		return { buffer, contentType: mimeType, extension };
	}

	// Convert to WebP with optimization (effort 4 = balanced speed/compression)
	const optimized = await sharp(buffer)
		.webp({ quality: 85, effort: 4 }) // effort: 0-6, 4 is faster than 6 with minimal quality loss
		.toBuffer();

	return { buffer: optimized, contentType: "image/webp", extension: "webp" };
}

async function uploadImageToR2(
	buffer: Buffer,
	contentType: string,
): Promise<string> {
	// Skip collision check - nanoid(12) has 4.7 quadrillion possibilities, collision is astronomically unlikely
	const mimeToExt: Record<string, string> = {
		"image/svg+xml": "svg",
		"image/webp": "webp",
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
	};
	const extension = mimeToExt[contentType] || "webp";
	const imageKey = `${nanoid(12)}.${extension}`;

	// Upload to R2 using the S3 client
	await s3.write(imageKey, buffer, { type: contentType });

	return imageKey;
}

// HTTP server for Slack events
const server = Bun.serve({
	port: process.env.PORT || 3000,

	routes: {
		"/": {
			GET(request) {
				const accept = request.headers.get("Accept") || "";
				if (accept.includes("text/html")) {
					const url = new URL(request.url);
					return Response.redirect(`${url.origin}/dashboard`, 302);
				}

				const banner = `
  ██╗     ██╗  ██╗
  ██║     ██║  ██║
  ██║     ███████║
  ██║     ╚════██║
  ███████╗     ██║
  ╚══════╝     ╚═╝
  
  L4 Image CDN
  
  Endpoints:
    POST /upload      Upload an image
    GET  /i/:key      Fetch an image
    GET  /dashboard   Stats dashboard
    GET  /health      Health check
`;
				return new Response(banner, {
					headers: { "Content-Type": "text/plain" },
				});
			},
		},

		"/slack/events": {
			async POST(request) {
				return handleSlackEvent(request);
			},
		},

		"/upload": {
			async POST(request) {
				return handleUpload(request);
			},
		},

		"/health": {
			async GET(_request) {
				return Response.json({ status: "ok" });
			},
		},

		"/dashboard": dashboard,

		"/api/stats/overview": {
			GET(request) {
				const url = new URL(request.url);
				const days = parseInt(url.searchParams.get("days") || "7", 10);
				const safeDays = Math.min(Math.max(days, 1), 365);

				return Response.json({
					totalHits: getTotalHits(safeDays),
					uniqueImages: getUniqueImages(safeDays),
					topImages: getTopImages(safeDays, 20),
				});
			},
		},

		"/api/stats/traffic": {
			GET(request) {
				const url = new URL(request.url);
				const startParam = url.searchParams.get("start");
				const endParam = url.searchParams.get("end");

				if (startParam && endParam) {
					// Zoom mode: specific time range
					const start = parseInt(startParam, 10);
					const end = parseInt(endParam, 10);
					const spanDays = (end - start) / 86400;

					return Response.json(
						getTraffic(spanDays, { startTime: start, endTime: end }),
					);
				}

				// Normal mode: last N days
				const days = parseInt(url.searchParams.get("days") || "7", 10);
				const safeDays = Math.min(Math.max(days, 1), 365);

				return Response.json(getTraffic(safeDays));
			},
		},

		"/api/stats/image/:key": {
			GET(request) {
				const imageKey = request.params.key;
				const url = new URL(request.url);
				const days = parseInt(url.searchParams.get("days") || "30", 10);
				const safeDays = Math.min(Math.max(days, 1), 365);

				return Response.json(getStats(imageKey, safeDays));
			},
		},

		"/i/:key": {
			async GET(request) {
				const imageKey = request.params.key;
				if (!imageKey) {
					return new Response("Not found", { status: 404 });
				}

				recordHit(imageKey);

				if (!R2_PUBLIC_URL) {
					return new Response("R2_PUBLIC_URL not configured", { status: 500 });
				}

				return Response.redirect(`${R2_PUBLIC_URL}/${imageKey}`, 307);
			},
		},
	},

	// Fallback for unmatched routes
	async fetch(_request) {
		return new Response("Not found", { status: 404 });
	},
	development: process.env?.NODE_ENV === "dev",
});

async function handleUpload(request: Request) {
	try {
		// Check auth token
		const authHeader = request.headers.get("Authorization");
		if (!AUTH_TOKEN || authHeader !== `Bearer ${AUTH_TOKEN}`) {
			return new Response("Unauthorized", { status: 401 });
		}

		// Parse multipart form data
		const formData = await request.formData();
		const file = formData.get("file") as File;

		if (!file) {
			return Response.json(
				{ success: false, error: "No file provided" },
				{ status: 400 },
			);
		}

		// Check if preserveFormat is requested
		const preserveFormat = formData.get("preserveFormat") === "true";

		// Read file buffer
		const originalBuffer = Buffer.from(await file.arrayBuffer());
		const contentType = file.type || "image/jpeg";

		// Optimize image
		const { buffer: optimizedBuffer, contentType: newContentType } =
			await optimizeImage(originalBuffer, contentType, preserveFormat);

		// Upload to R2
		const imageKey = await uploadImageToR2(optimizedBuffer, newContentType);
		const url = `${PUBLIC_URL}/i/${imageKey}`;

		return Response.json({ success: true, url });
	} catch (error) {
		console.error("Error handling upload:", error);
		return Response.json(
			{ success: false, error: "Upload failed" },
			{ status: 500 },
		);
	}
}

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

		// Handle message events
		if (
			payload.type === "event_callback" &&
			payload.event?.type === "message"
		) {
			const event = payload.event;

			// Check if channel is allowed
			if (
				ALLOWED_CHANNELS.length > 0 &&
				!ALLOWED_CHANNELS.includes(event.channel)
			) {
				return new Response("OK", { status: 200 });
			}

			// Handle "delete" command in threads
			const text = (event.text || "").toLowerCase().trim();
			if (event.thread_ts && text === "delete") {
				handleDeleteRequest(event).catch(console.error);
				return new Response("OK", { status: 200 });
			}

			// Handle thread replies with files as replacements
			if (event.thread_ts && event.files?.length > 0) {
				handleReplaceRequest(event).catch(console.error);
				return new Response("OK", { status: 200 });
			}

			// Ignore other thread replies
			if (event.thread_ts) {
				return new Response("OK", { status: 200 });
			}

			// Check for files
			if (!event.files || event.files.length === 0) {
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

interface SlackFile {
	url_private: string;
	name: string;
	mimetype: string;
}

interface SlackMessageEvent {
	text?: string;
	files?: SlackFile[];
	channel: string;
	ts: string;
	thread_ts?: string;
	user?: string;
}

async function purgeCache(keys: string[]) {
	if (!CF_ZONE_ID || !CF_API_TOKEN) return;
	const urls = keys.map((key) => `${PUBLIC_URL}/i/${key}`);
	await fetch(
		`https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${CF_API_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ files: urls }),
		},
	).catch((err) => console.error("Cache purge failed:", err));
}

// Find image keys, original uploader, and bot message ts from a thread
async function getThreadInfo(
	channel: string,
	threadTs: string,
): Promise<{ keys: string[]; originalUser: string | null; botMessageTs: string | null }> {
	const params = new URLSearchParams({ channel, ts: threadTs });
	const response = await fetch(
		`https://slack.com/api/conversations.replies?${params}`,
		{
			headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
		},
	);
	const data = await response.json();
	if (!data.ok) {
		throw new Error(`Slack API error: ${data.error}`);
	}

	const messages = data.messages || [];
	const originalUser = messages[0]?.user || null;

	const urlPattern = new RegExp(
		`${PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/i/([\\w-]+\\.[a-z]+)`,
		"g",
	);

	const keys: string[] = [];
	let botMessageTs: string | null = null;
	for (const msg of messages) {
		if (msg.bot_id || msg.subtype === "bot_message") {
			let match: RegExpExecArray | null;
			while ((match = urlPattern.exec(msg.text || "")) !== null) {
				keys.push(match[1]);
			}
			if (keys.length > 0 && !botMessageTs) {
				botMessageTs = msg.ts;
			}
		}
	}
	return { keys, originalUser, botMessageTs };
}

async function handleDeleteRequest(event: SlackMessageEvent) {
	try {
		const { keys, originalUser, botMessageTs } = await getThreadInfo(
			event.channel,
			event.thread_ts!,
		);

		// Only allow the original uploader or admins to delete
		const isOriginalUser = originalUser && event.user === originalUser;
		const isAdmin = event.user && ADMIN_USERS.includes(event.user);
		if (!isOriginalUser && !isAdmin) {
			await callSlackAPI("reactions.add", {
				channel: event.channel,
				timestamp: event.ts,
				name: "no_entry",
			});
			return;
		}

		if (keys.length === 0 || !botMessageTs) {
			return;
		}

		// Delete images from R2 and stats DB
		await Promise.all(keys.map((key) => s3.delete(key)));
		keys.forEach((key) => deleteImageStats(key));
		await purgeCache(keys);
		console.log(`Deleted ${keys.length} image(s): ${keys.join(", ")}`);

		// Strikethrough the bot's message
		const strikethroughText = keys
			.map((key) => `~${PUBLIC_URL}/i/${key}~`)
			.join("\n");

		await Promise.all([
			// React on the delete message
			callSlackAPI("reactions.add", {
				channel: event.channel,
				timestamp: event.ts,
				name: "yay-still",
			}),
			// Strikethrough the bot's URL message
			callSlackAPI("chat.update", {
				channel: event.channel,
				ts: botMessageTs,
				text: strikethroughText,
			}),
			// Add boomparrot to the original top-level message
			callSlackAPI("reactions.add", {
				channel: event.channel,
				timestamp: event.thread_ts!,
				name: "boomparrot",
			}),
			// Remove yay from the original top-level message
			callSlackAPI("reactions.remove", {
				channel: event.channel,
				timestamp: event.thread_ts!,
				name: "yay-still",
			}).catch(() => {}),
		]);
	} catch (error) {
		console.error("Error handling delete request:", error);
		await callSlackAPI("reactions.add", {
			channel: event.channel,
			timestamp: event.ts,
			name: "rac-concern",
		}).catch(console.error);
	}
}

async function handleReplaceRequest(event: SlackMessageEvent) {
	try {
		const { keys, originalUser } = await getThreadInfo(
			event.channel,
			event.thread_ts!,
		);

		// Only allow the original uploader or admins to replace
		const isOriginalUser = originalUser && event.user === originalUser;
		const isAdmin = event.user && ADMIN_USERS.includes(event.user);
		if (!isOriginalUser && !isAdmin) {
			await callSlackAPI("reactions.add", {
				channel: event.channel,
				timestamp: event.ts,
				name: "no_entry",
			});
			return;
		}

		if (keys.length === 0) {
			return;
		}

		const loadingReaction = callSlackAPI("reactions.add", {
			channel: event.channel,
			timestamp: event.ts,
			name: "spinny_fox",
		});

		const files = event.files || [];
		await Promise.all(
			files.map(async (file, index) => {
				if (index >= keys.length) return;

				const existingKey = keys[index];
				const existingExt = existingKey.split(".").pop() || "";
				const preserveFormat = existingExt !== "webp";

				const fileResponse = await fetch(file.url_private, {
					headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
				});
				if (!fileResponse.ok) {
					throw new Error("Failed to download file from Slack");
				}

				const originalBuffer = Buffer.from(await fileResponse.arrayBuffer());
				const contentType = file.mimetype || "image/jpeg";

				const { buffer: optimizedBuffer, contentType: newContentType } =
					await optimizeImage(originalBuffer, contentType, preserveFormat);

				await s3.write(existingKey, optimizedBuffer, { type: newContentType });
				console.log(`Replaced in R2: ${existingKey}`);
			}),
		);

		const replacedKeys = keys.slice(0, files.length);
		await purgeCache(replacedKeys);

		await loadingReaction;

		await Promise.all([
			callSlackAPI("reactions.remove", {
				channel: event.channel,
				timestamp: event.ts,
				name: "spinny_fox",
			}),
			callSlackAPI("reactions.add", {
				channel: event.channel,
				timestamp: event.ts,
				name: "yay-still",
			}),
		]);
	} catch (error) {
		console.error("Error handling replace request:", error);
		await callSlackAPI("reactions.add", {
			channel: event.channel,
			timestamp: event.ts,
			name: "rac-concern",
		}).catch(console.error);
	}
}

async function processSlackFiles(event: SlackMessageEvent) {
	try {
		// Check if message text contains "preserve" or "png" to keep original format
		const text = event.text?.toLowerCase() ?? "";
		const preserveFormat =
			text.includes("preserve") || text.includes("png");

		// React with loading emoji (don't await - do it in parallel with downloads)
		const loadingReaction = callSlackAPI("reactions.add", {
			channel: event.channel,
			timestamp: event.ts,
			name: "spinny_fox",
		});

		// Process all files in parallel
		const filePromises = (event.files || []).map(async (file) => {
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

				// Optimize image (preserve format if message says "preserve")
				const { buffer: optimizedBuffer, contentType: newContentType } =
					await optimizeImage(originalBuffer, contentType, preserveFormat);

				const savings = (
					(1 - optimizedBuffer.length / originalBuffer.length) *
					100
				).toFixed(1);
				if (preserveFormat) {
					console.log(
						`Uploaded: ${originalBuffer.length} bytes (format preserved)`,
					);
				} else {
					console.log(
						`Optimized: ${originalBuffer.length} → ${optimizedBuffer.length} bytes (${savings}% reduction)`,
					);
				}

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
		const apiCalls: Promise<unknown>[] = [
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
					name: "yay-still",
				}),
				// Post URLs in thread
				callSlackAPI("chat.postMessage", {
					channel: event.channel,
					thread_ts: event.ts,
					text: urls.join("\n"),
				}),
			);
		} else {
			apiCalls.push(
				// Add error reaction
				callSlackAPI("reactions.add", {
					channel: event.channel,
					timestamp: event.ts,
					name: "rac-concern",
				}),
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

async function callSlackAPI(method: string, params: Record<string, unknown>) {
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
console.log(`- S3 Bucket: ${S3_BUCKET}`);
console.log(`- S3 Endpoint: ${S3_ENDPOINT}`);
console.log(`- S3 Region: ${S3_REGION}`);
console.log(`- R2 Public URL: ${R2_PUBLIC_URL}`);
console.log(`- Public URL: ${PUBLIC_URL}`);
console.log(`- Slack events: ${PUBLIC_URL}/slack/events`);
