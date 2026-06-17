import dashboard from "./dashboard.html";
import { optimizeImage, uploadImageToR2 } from "./images";
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
		},
	},

	async fetch(_request) {
		return new Response("Not found", { status: 404 });
	},
	development: process.env?.NODE_ENV === "dev",
});

async function handleUpload(request: Request) {
	try {
		const authHeader = request.headers.get("Authorization");
		if (!AUTH_TOKEN || authHeader !== `Bearer ${AUTH_TOKEN}`) {
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

console.log(`L4 Image CDN started on port ${server.port}`);
console.log(`- Public URL: ${PUBLIC_URL}`);
console.log(`- R2 Public URL: ${R2_PUBLIC_URL}`);
console.log(`- Slack events: ${PUBLIC_URL}/slack/events`);
