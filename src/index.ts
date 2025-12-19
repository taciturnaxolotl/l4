import { nanoid } from "nanoid";
import { SlackApp, type SlackEdgeAppEnv } from "slack-edge";
import { optimizeImage } from "wasm-image-optimization";

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
				const allowedChannels =
					env.ALLOWED_CHANNELS?.split(",").map((c) => c.trim()) || [];
				if (
					allowedChannels.length > 0 &&
					!allowedChannels.includes(payload.channel)
				) {
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

						// Optimize and upload to R2
						const { key: imageKey } = await optimizeAndUpload(
							env,
							fileBlob,
							file.name || "image.jpg",
						);

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
						name: "yay-still",
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

	// Verify object exists before redirecting
	const object = await env.IMAGES.head(imageKey);
	if (!object) {
		return new Response("Not found", { status: 404 });
	}

	// Redirect to R2 public URL - much more efficient than proxying
	const r2PublicUrl = `${env.R2_PUBLIC_URL}/${imageKey}`;
	return Response.redirect(r2PublicUrl, 307);
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
			"image/svg+xml",
		];
		if (!validTypes.includes(contentType)) {
			return new Response(JSON.stringify({ error: "Invalid file type" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Optimize and upload
		const { key: imageKey } = await optimizeAndUpload(env, file, file.name);

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
	R2_PUBLIC_URL: string;
	ALLOWED_CHANNELS?: string;
}

// Helper to optimize images before uploading
async function optimizeAndUpload(
	env: Env,
	imageBlob: Blob,
	originalFilename: string,
): Promise<{ key: string; contentType: string }> {
	const contentType = imageBlob.type;

	// SVGs: store as-is without conversion
	if (contentType === "image/svg+xml") {
		let imageKey: string;
		let attempts = 0;
		const maxAttempts = 10;
		
		do {
			imageKey = `${nanoid(12)}.svg`;
			const exists = await env.IMAGES.head(imageKey);
			if (!exists) break;
			attempts++;
		} while (attempts < maxAttempts);

		if (attempts >= maxAttempts) {
			throw new Error("Failed to generate unique image key");
		}

		await env.IMAGES.put(imageKey, imageBlob.stream(), {
			httpMetadata: {
				contentType: "image/svg+xml",
			},
		});

		return { key: imageKey, contentType: "image/svg+xml" };
	}

	// Other formats: optimize and convert to WebP
	const imageBuffer = await imageBlob.arrayBuffer();

	const optimized = await optimizeImage({
		image: imageBuffer,
		width: undefined, // Keep original dimensions
		height: undefined,
		format: "webp",
		quality: 85,
	});

	// Generate random key with collision detection
	let imageKey: string;
	let attempts = 0;
	const maxAttempts = 10;
	
	do {
		imageKey = `${nanoid(12)}.webp`;
		const exists = await env.IMAGES.head(imageKey);
		if (!exists) break;
		attempts++;
	} while (attempts < maxAttempts);

	if (attempts >= maxAttempts) {
		throw new Error("Failed to generate unique image key");
	}

	// Upload optimized version to R2
	await env.IMAGES.put(imageKey, optimized, {
		httpMetadata: {
			contentType: "image/webp",
		},
	});

	return { key: imageKey, contentType: "image/webp" };
}
