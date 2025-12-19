import { nanoid } from "nanoid";
import indexHTML from "./index.html";
import loginHTML from "./login.html";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Public routes
		if (url.pathname === "/login" && request.method === "GET") {
			return new Response(loginHTML, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Serve images publicly (no auth required)
		if (url.pathname.startsWith("/i/")) {
			return handleImageRequest(request, env, ctx);
		}

		// OAuth initiation
		if (url.pathname === "/api/login" && request.method === "GET") {
			const state = nanoid(32);
			const codeVerifier = generateCodeVerifier();
			const codeChallenge = await generateCodeChallenge(codeVerifier);

			await env.L4.put(`oauth:${state}`, JSON.stringify({ codeVerifier }), {
				expirationTtl: 600,
			});

			const redirectUri = `${env.HOST}/api/callback`;
			const authUrl = new URL("/auth/authorize", env.INDIKO_URL);
			authUrl.searchParams.set("response_type", "code");
			authUrl.searchParams.set("client_id", env.INDIKO_CLIENT_ID);
			authUrl.searchParams.set("redirect_uri", redirectUri);
			authUrl.searchParams.set("state", state);
			authUrl.searchParams.set("code_challenge", codeChallenge);
			authUrl.searchParams.set("code_challenge_method", "S256");
			authUrl.searchParams.set("scope", "profile email");

			return Response.redirect(authUrl.toString(), 302);
		}

		// OAuth callback
		if (url.pathname === "/api/callback" && request.method === "GET") {
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");

			if (!code || !state) {
				return Response.redirect(
					new URL("/login?error=missing_params", request.url).toString(),
					302,
				);
			}

			const oauthData = await env.L4.get(`oauth:${state}`);
			if (!oauthData) {
				return Response.redirect(
					new URL("/login?error=invalid_state", request.url).toString(),
					302,
				);
			}

			const { codeVerifier } = JSON.parse(oauthData);
			await env.L4.delete(`oauth:${state}`);

			try {
				const redirectUri = `${env.HOST}/api/callback`;
				const tokenUrl = new URL("/auth/token", env.INDIKO_URL);
				const tokenBody = new URLSearchParams({
					grant_type: "authorization_code",
					code,
					client_id: env.INDIKO_CLIENT_ID,
					client_secret: env.INDIKO_CLIENT_SECRET,
					redirect_uri: redirectUri,
					code_verifier: codeVerifier,
				});

				const tokenResponse = await fetch(tokenUrl.toString(), {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: tokenBody.toString(),
				});

				if (!tokenResponse.ok) {
					return Response.redirect(
						new URL("/login?error=token_exchange_failed", request.url).toString(),
						302,
					);
				}

				const tokenData = await tokenResponse.json();

				if (tokenData.role !== "admin" && tokenData.role !== "viewer") {
					return Response.redirect(
						new URL("/login?error=unauthorized_role", request.url).toString(),
						302,
					);
				}

				const sessionToken = nanoid(32);
				const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

				await env.L4.put(
					`session:${sessionToken}`,
					JSON.stringify({
						expiresAt,
						profile: tokenData.profile,
						me: tokenData.me,
						role: tokenData.role,
					}),
					{ expirationTtl: 86400 },
				);

				const redirectUrl = new URL("/", request.url);
				redirectUrl.searchParams.set("token", sessionToken);
				return Response.redirect(redirectUrl.toString(), 302);
			} catch (error) {
				return Response.redirect(
					new URL("/login?error=unknown", request.url).toString(),
					302,
				);
			}
		}

		// Logout
		if (url.pathname === "/api/logout" && request.method === "POST") {
			const authHeader = request.headers.get("Authorization");
			if (authHeader && authHeader.startsWith("Bearer ")) {
				const token = authHeader.slice(7);
				await env.L4.delete(`session:${token}`);
			}
			return new Response(JSON.stringify({ success: true }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Get current user
		if (url.pathname === "/api/me" && request.method === "GET") {
			const authHeader = request.headers.get("Authorization");
			if (!authHeader || !authHeader.startsWith("Bearer ")) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			const token = authHeader.slice(7);
			const sessionData = await env.L4.get(`session:${token}`);

			if (!sessionData) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			const session = JSON.parse(sessionData);
			return new Response(
				JSON.stringify({
					role: session.role,
					profile: session.profile,
					me: session.me,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		}

		// Auth required for management routes
		let userRole: string | null = null;
		if (url.pathname !== "/") {
			const authHeader = request.headers.get("Authorization");
			if (!authHeader) {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (authHeader.startsWith("Bearer ")) {
				const token = authHeader.slice(7);

				// Check if it's an API key
				const apiKeyData = await env.L4.get(`apikey:${token}`);
				if (apiKeyData) {
					const apiKey = JSON.parse(apiKeyData);
					if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
						await env.L4.delete(`apikey:${token}`);
						return new Response(JSON.stringify({ error: "API key expired" }), {
							status: 401,
							headers: { "Content-Type": "application/json" },
						});
					}
					userRole = "admin"; // API keys have admin access
				} else {
					// Check session token
					const sessionData = await env.L4.get(`session:${token}`);
					if (!sessionData) {
						return new Response(JSON.stringify({ error: "Unauthorized" }), {
							status: 401,
							headers: { "Content-Type": "application/json" },
						});
					}

					const session = JSON.parse(sessionData);
					if (session.expiresAt < Date.now()) {
						await env.L4.delete(`session:${token}`);
						return new Response(JSON.stringify({ error: "Unauthorized" }), {
							status: 401,
							headers: { "Content-Type": "application/json" },
						});
					}
					userRole = session.role;
				}
			} else {
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Block write operations for viewers
			const isWriteOperation =
				(url.pathname === "/api/upload" && request.method === "POST") ||
				(url.pathname.startsWith("/api/images/") && request.method === "DELETE") ||
				(url.pathname === "/api/keys" && request.method === "POST") ||
				(url.pathname.startsWith("/api/keys/") && request.method === "DELETE");

			if (isWriteOperation && userRole === "viewer") {
				return new Response(
					JSON.stringify({ error: "Forbidden: View-only access" }),
					{ status: 403, headers: { "Content-Type": "application/json" } },
				);
			}
		}

		// Main app
		if (url.pathname === "/" && request.method === "GET") {
			return new Response(indexHTML, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Upload image
		if (url.pathname === "/api/upload" && request.method === "POST") {
			return handleImageUpload(request, env);
		}

		// List images
		if (url.pathname === "/api/images" && request.method === "GET") {
			return handleListImages(request, env);
		}

		// Delete image
		if (url.pathname.startsWith("/api/images/") && request.method === "DELETE") {
			const imageKey = url.pathname.split("/")[3];
			return handleDeleteImage(imageKey, env);
		}

		// API key management
		if (url.pathname === "/api/keys" && request.method === "GET") {
			return handleListApiKeys(env);
		}

		if (url.pathname === "/api/keys" && request.method === "POST") {
			return handleCreateApiKey(request, env);
		}

		if (url.pathname.startsWith("/api/keys/") && request.method === "DELETE") {
			const keyId = url.pathname.split("/")[3];
			return handleDeleteApiKey(keyId, env);
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
				"Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
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
	const isLocalDev = url.hostname === "localhost" || url.hostname.includes("127.0.0.1");
	
	if (isLocalDev) {
		const headers = new Headers();
		headers.set("Content-Type", object.httpMetadata?.contentType || "image/png");
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
	response.headers.set("Cache-Control", "public, max-age=31536000, s-maxage=86400");
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
		const customKey = formData.get("key") as string | null;

		if (!file) {
			return new Response(JSON.stringify({ error: "No file provided" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Validate file type
		const contentType = file.type;
		const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];
		if (!validTypes.includes(contentType)) {
			return new Response(JSON.stringify({ error: "Invalid file type" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Generate key or use custom
		const extension = file.name.split(".").pop() || "jpg";
		const imageKey = customKey || `${nanoid(12)}.${extension}`;

		// Upload to R2
		await env.IMAGES.put(imageKey, file.stream(), {
			httpMetadata: {
				contentType,
			},
			customMetadata: {
				originalName: file.name,
				uploadedAt: new Date().toISOString(),
			},
		});

		// Store metadata in KV
		await env.L4.put(
			`img:${imageKey}`,
			JSON.stringify({
				key: imageKey,
				originalName: file.name,
				contentType,
				size: file.size,
				uploadedAt: new Date().toISOString(),
			}),
		);

		const imageUrl = `${new URL(request.url).origin}/i/${imageKey}`;

		return new Response(
			JSON.stringify({
				success: true,
				key: imageKey,
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

async function handleListImages(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const limit = parseInt(url.searchParams.get("limit") || "100");
	const cursor = url.searchParams.get("cursor") || undefined;

	const listOptions: KVNamespaceListOptions = {
		prefix: "img:",
		limit: Math.min(limit, 1000),
		cursor,
	};

	const list = await env.L4.list(listOptions);

	const images = await Promise.all(
		list.keys.map(async (key) => {
			const data = await env.L4.get(key.name);
			return data ? JSON.parse(data) : null;
		}),
	);

	return new Response(
		JSON.stringify({
			images: images.filter(Boolean),
			cursor: list.list_complete ? null : list.cursor,
			hasMore: !list.list_complete,
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
}

async function handleDeleteImage(
	imageKey: string,
	env: Env,
): Promise<Response> {
	try {
		// Delete from R2
		await env.IMAGES.delete(imageKey);

		// Delete metadata
		await env.L4.delete(`img:${imageKey}`);

		return new Response(JSON.stringify({ success: true }), {
			headers: { "Content-Type": "application/json" },
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: "Delete failed" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}

async function handleListApiKeys(env: Env): Promise<Response> {
	const list = await env.L4.list({ prefix: "apikey:" });

	const keys = await Promise.all(
		list.keys.map(async (key) => {
			const data = await env.L4.get(key.name);
			if (!data) return null;
			const apiKey = JSON.parse(data);
			return {
				id: key.name.slice(7),
				name: apiKey.name,
				createdAt: apiKey.createdAt,
				expiresAt: apiKey.expiresAt,
				lastUsed: apiKey.lastUsed,
			};
		}),
	);

	return new Response(
		JSON.stringify({ keys: keys.filter(Boolean) }),
		{ headers: { "Content-Type": "application/json" } },
	);
}

async function handleCreateApiKey(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const { name, expiresInDays } = await request.json();

		if (!name) {
			return new Response(JSON.stringify({ error: "Name is required" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		const apiKey = nanoid(32);
		const expiresAt = expiresInDays
			? Date.now() + expiresInDays * 24 * 60 * 60 * 1000
			: null;

		await env.L4.put(
			`apikey:${apiKey}`,
			JSON.stringify({
				name,
				createdAt: Date.now(),
				expiresAt,
				lastUsed: null,
			}),
		);

		return new Response(
			JSON.stringify({
				success: true,
				apiKey,
				name,
				expiresAt,
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	} catch (error) {
		return new Response(JSON.stringify({ error: "Invalid request" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}
}

async function handleDeleteApiKey(
	keyId: string,
	env: Env,
): Promise<Response> {
	await env.L4.delete(`apikey:${keyId}`);

	return new Response(JSON.stringify({ success: true }), {
		headers: { "Content-Type": "application/json" },
	});
}

function generateCodeVerifier(): string {
	return nanoid(64);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return base64UrlEncode(new Uint8Array(hash));
}

function base64UrlEncode(buffer: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < buffer.byteLength; i++) {
		binary += String.fromCharCode(buffer[i]);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

interface Env {
	L4: KVNamespace;
	IMAGES: R2Bucket;
	HOST: string;
	INDIKO_URL: string;
	INDIKO_CLIENT_ID: string;
	INDIKO_CLIENT_SECRET: string;
}
