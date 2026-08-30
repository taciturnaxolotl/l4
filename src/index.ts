import { purgeCache } from "./cache";
import dashboard from "./dashboard.html";
import {
	imageExistsInR2,
	optimizeImage,
	overwriteImageInR2,
	uploadImageToR2,
} from "./images";
import { handleSlackEvent } from "./slack";
import {
	getStats,
	getTopImages,
	getTotalHits,
	getTraffic,
	getUniqueImages,
	recordHit,
} from "./stats";

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";
const AUTH_TOKEN = process.env.AUTH_TOKEN;

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Max-Age": "86400",
};

function withCorsHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(CORS_HEADERS)) {
		headers.set(key, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// Bun routes have no middleware hook, so wrap every handler once at definition.
type RouteHandler = (request: Request & { params: any }, server: any) => any;

function withCors<R extends string>(
	routes: Bun.Serve.Routes<undefined, R>,
): Bun.Serve.Routes<undefined, R> {
	const wrap =
		(handler: RouteHandler): RouteHandler =>
		async (request, server) =>
			withCorsHeaders(await handler(request, server));

	const wrapped: Record<string, unknown> = {};
	for (const [path, route] of Object.entries(routes)) {
		if (typeof route === "function") {
			wrapped[path] = wrap(route as RouteHandler);
		} else if (
			route &&
			typeof route === "object" &&
			Object.values(route).every((handler) => typeof handler === "function")
		) {
			wrapped[path] = {
				OPTIONS: () => withCorsHeaders(new Response(null, { status: 204 })),
				...Object.fromEntries(
					Object.entries(route).map(([method, handler]) => [
						method,
						wrap(handler as RouteHandler),
					]),
				),
			};
		} else {
			// HTML bundles (the dashboard) pass through untouched.
			wrapped[path] = route;
		}
	}
	return wrapped as Bun.Serve.Routes<undefined, R>;
}

function isAuthorized(request: Request): boolean {
	return (
		!!AUTH_TOKEN &&
		request.headers.get("Authorization") === `Bearer ${AUTH_TOKEN}`
	);
}

const server = Bun.serve({
	port: process.env.PORT || 3000,

	routes: withCors({
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
					const start = parseInt(startParam, 10);
					const end = parseInt(endParam, 10);
					const spanDays = (end - start) / 86400;

					return Response.json(
						getTraffic(spanDays, { startTime: start, endTime: end }),
					);
				}

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

				queueMicrotask(() => recordHit(imageKey));

				if (!R2_PUBLIC_URL) {
					return new Response("R2_PUBLIC_URL not configured", { status: 500 });
				}

				return Response.redirect(`${R2_PUBLIC_URL}/${imageKey}`, 307);
			},

			async PUT(request) {
				return handleOverwrite(request, request.params.key);
			},
		},
	}),

	async fetch(_request) {
		return withCorsHeaders(new Response("Not found", { status: 404 }));
	},
	development: process.env?.NODE_ENV === "dev",
});

async function handleUpload(request: Request) {
	try {
		if (!isAuthorized(request)) {
			return new Response("Unauthorized", { status: 401 });
		}

		const formData = await request.formData();
		const file = formData.get("file") as File;

		if (!file) {
			return Response.json(
				{ success: false, error: "No file provided" },
				{ status: 400 },
			);
		}

		const preserveFormat = formData.get("preserveFormat") === "true";

		const originalBuffer = Buffer.from(await file.arrayBuffer());
		const contentType = file.type || "image/jpeg";

		const { buffer: optimizedBuffer, contentType: newContentType } =
			await optimizeImage(originalBuffer, contentType, preserveFormat);

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

async function handleOverwrite(request: Request, imageKey: string) {
	try {
		if (!isAuthorized(request)) {
			return new Response("Unauthorized", { status: 401 });
		}

		if (!imageKey || !(await imageExistsInR2(imageKey))) {
			return Response.json(
				{ success: false, error: "Image not found" },
				{ status: 404 },
			);
		}

		const formData = await request.formData();
		const file = formData.get("file") as File;

		if (!file) {
			return Response.json(
				{ success: false, error: "No file provided" },
				{ status: 400 },
			);
		}

		// The key carries its extension, so the replacement keeps the old format.
		const preserveFormat = imageKey.split(".").pop() !== "webp";

		const originalBuffer = Buffer.from(await file.arrayBuffer());
		const contentType = file.type || "image/jpeg";

		const { buffer: optimizedBuffer, contentType: newContentType } =
			await optimizeImage(originalBuffer, contentType, preserveFormat);

		await overwriteImageInR2(imageKey, optimizedBuffer, newContentType);
		console.log(`Replaced in R2: ${imageKey}`);

		// Purging waits on R2 propagation; don't hold the response for it.
		void purgeCache([imageKey]);

		return Response.json({ success: true, url: `${PUBLIC_URL}/i/${imageKey}` });
	} catch (error) {
		console.error("Error handling overwrite:", error);
		return Response.json(
			{ success: false, error: "Overwrite failed" },
			{ status: 500 },
		);
	}
}

console.log(`L4 Image CDN started on port ${server.port}`);
console.log(`- Public URL: ${PUBLIC_URL}`);
console.log(`- R2 Public URL: ${R2_PUBLIC_URL}`);
console.log(`- Slack events: ${PUBLIC_URL}/slack/events`);
