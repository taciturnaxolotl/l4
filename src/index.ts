import { nanoid } from "nanoid";
import { SlackApp, SlackEdgeAppEnv } from "slack-edge";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Serve images publicly (no auth required)
		if (url.pathname.startsWith("/i/")) {
			return handleImageRequest(request, env, ctx);
		}

		// Slack events
		if (url.pathname === "/slack/events") {
			const slackApp = new SlackApp({
				env: env as any as SlackEdgeAppEnv,
			});

			// Handle file uploads
			slackApp.event("message", async ({ payload, context }) => {
				if (!payload.files || payload.files.length === 0) {
					return;
				}

				// Check if channel is allowed
				const allowedChannels = env.ALLOWED_CHANNELS?.split(",").map(c => c.trim()) || [];
				if (allowedChannels.length > 0 && !allowedChannels.includes(payload.channel)) {
					return;
				}

				// React with loading emoji
				await context.client.reactions.add({
					channel: payload.channel,
					timestamp: payload.ts,
					name: "spinny_fox",
				});

				try {
					const urls: string[] = [];

					for (const file of payload.files) {
						// Download file from Slack
						const fileResponse = await fetch(file.url_private!, {
							headers: {
								Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
							},
						});

						if (!fileResponse.ok) {
							throw new Error("Failed to download file from Slack");
						}

						const fileBlob = await fileResponse.blob();

						// Determine extension
						const extension =
							file.name?.split(".").pop() ||
							file.filetype ||
							"jpg";

						// Generate random key
						const imageKey = `${nanoid(12)}.${extension}`;

						// Upload to R2
						await env.IMAGES.put(imageKey, fileBlob.stream(), {
							httpMetadata: {
								contentType: file.mimetype || "application/octet-stream",
							},
						});

						const imageUrl = `${env.PUBLIC_URL}/i/${imageKey}`;
						urls.push(imageUrl);
					}

					// Remove loading reaction
					await context.client.reactions.remove({
						channel: payload.channel,
						timestamp: payload.ts,
						name: "spinny_fox",
					});

					// Add success reaction
					await context.client.reactions.add({
						channel: payload.channel,
						timestamp: payload.ts,
						name: "good_move",
					});

					// Post URLs in thread
					await context.client.chat.postMessage({
						channel: payload.channel,
						thread_ts: payload.ts,
						text: urls.join("\n"),
					});
				} catch (error) {
					// Remove loading reaction
					await context.client.reactions.remove({
						channel: payload.channel,
						timestamp: payload.ts,
						name: "spinny_fox",
					});

					// Add error reaction
					await context.client.reactions.add({
						channel: payload.channel,
						timestamp: payload.ts,
						name: "rac-concern",
					});
				}
			});

			return await slackApp.run(request, ctx);
		}

		// Upload image (requires auth)
		if (url.pathname === "/upload" && request.method === "POST") {
			const authHeader = request.headers.get("Authorization");
			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			const token = authHeader.slice(7);
			if (token !== env.AUTH_TOKEN) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			return handleImageUpload(request, env);
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleImageRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	const imageKey = url.pathname.slice(3); // Remove /i/

	if (!imageKey) {
		return new Response("Not found", { status: 404 });
	}

	// Prevent infinite loops
	if (/image-resizing/.test(request.headers.get("via") || "")) {
		const object = await env.IMAGES.get(imageKey);
		if (!object) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(object.body, {
			headers: {
				"Content-Type":
					object.httpMetadata?.contentType || "application/octet-stream",
				"Cache-Control": "public, max-age=31536000",
			},
		});
	}

	// Parse transformation params
	const width = url.searchParams.get("w");
	const height = url.searchParams.get("h");
	const quality = url.searchParams.get("q") || "85";
	const format = url.searchParams.get("f") || "auto";
	const fit = url.searchParams.get("fit") || "scale-down";

	// Check cache first
	const cacheKey = new Request(url.toString(), request);
	const cache = caches.default;
	let response = await cache.match(cacheKey);
	if (response) {
		return response;
	}

	// Fetch from R2
	const object = await env.IMAGES.get(imageKey);
	if (!object) {
		return new Response("Not found", { status: 404 });
	}

	// In local dev, Cloudflare image transformations don't work
	// So we just serve the original image
	const isLocalDev =
		url.hostname === "localhost" || url.hostname.includes("127.0.0.1");

	if (isLocalDev) {
		const headers = new Headers();
		headers.set(
			"Content-Type",
			object.httpMetadata?.contentType || "image/png",
		);
		headers.set("Cache-Control", "public, max-age=31536000");
		return new Response(object.body, { headers });
	}

	// Build image transformation options
	const imageOptions: any = {
		quality: parseInt(quality),
		format,
		fit,
	};

	if (width) imageOptions.width = parseInt(width);
	if (height) imageOptions.height = parseInt(height);

	// Determine format based on Accept header if auto
	if (format === "auto") {
		const accept = request.headers.get("accept") || "";
		if (/image\/avif/.test(accept)) {
			imageOptions.format = "avif";
		} else if (/image\/webp/.test(accept)) {
			imageOptions.format = "webp";
		}
	}

	// Fetch and transform
	const imageResponse = await fetch(request.url, {
		cf: {
			image: imageOptions,
		},
	});

	// Clone response with cache headers
	response = new Response(imageResponse.body, imageResponse);
	response.headers.set(
		"Cache-Control",
		"public, max-age=31536000, s-maxage=86400",
	);
	response.headers.set("Vary", "Accept");

	// Cache asynchronously
	ctx.waitUntil(cache.put(cacheKey, response.clone()));

	return response;
}

async function handleImageUpload(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const formData = await request.formData();
		const file = formData.get("file") as File;

		if (!file) {
			return new Response(JSON.stringify({ error: "No file provided" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Validate file type
		const contentType = file.type;
		const validTypes = [
			"image/jpeg",
			"image/png",
			"image/gif",
			"image/webp",
			"image/avif",
		];
		if (!validTypes.includes(contentType)) {
			return new Response(JSON.stringify({ error: "Invalid file type" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Generate random key
		const extension = file.name.split(".").pop() || "jpg";
		const imageKey = `${nanoid(12)}.${extension}`;

		// Upload to R2
		await env.IMAGES.put(imageKey, file.stream(), {
			httpMetadata: {
				contentType,
			},
		});

		const imageUrl = `${new URL(request.url).origin}/i/${imageKey}`;

		return new Response(
			JSON.stringify({
				success: true,
				url: imageUrl,
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	} catch (error) {
		return new Response(JSON.stringify({ error: "Upload failed" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}

interface Env extends SlackEdgeAppEnv {
	IMAGES: R2Bucket;
	AUTH_TOKEN: string;
	PUBLIC_URL: string;
	ALLOWED_CHANNELS?: string;
}
