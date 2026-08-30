import { purgeCache } from "./cache";
import {
	deleteImageFromR2,
	optimizeImage,
	overwriteImageInR2,
	uploadImageToR2,
} from "./images";
import { deleteImageStats } from "./stats";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";
const ALLOWED_CHANNELS =
	process.env.ALLOWED_CHANNELS?.split(",").map((c) => c.trim()) || [];
const ADMIN_USERS =
	process.env.ADMIN_USERS?.split(",").map((u) => u.trim()) || [];

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

// --- Signature verification ---

async function verifySlackSignature(
	request: Request,
	body: string,
): Promise<boolean> {
	if (!SLACK_SIGNING_SECRET) return false;

	const timestamp = request.headers.get("X-Slack-Request-Timestamp");
	if (!timestamp) return false;

	// Reject requests older than 5 minutes
	if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

	const sigBasestring = `v0:${timestamp}:${body}`;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(SLACK_SIGNING_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(sigBasestring),
	);
	const expected = `v0=${Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}`;

	const actual = request.headers.get("X-Slack-Signature");
	return expected === actual;
}

// --- Slack API helper ---

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

// --- Thread info + authorization ---

async function getThreadInfo(channel: string, threadTs: string) {
	const params = new URLSearchParams({ channel, ts: threadTs });
	const response = await fetch(
		`https://slack.com/api/conversations.replies?${params}`,
		{ headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
	);
	const data = await response.json();
	if (!data.ok) {
		throw new Error(`Slack API error: ${data.error}`);
	}

	const messages = data.messages || [];
	const originalUser: string | null = messages[0]?.user || null;

	const urlPattern = new RegExp(
		`${PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/i/([\\w-]+\\.[a-z]+)`,
		"g",
	);

	const keys: string[] = [];
	let botMessageTs: string | null = null;
	for (const msg of messages) {
		if (msg.bot_id || msg.subtype === "bot_message") {
			for (const match of (msg.text || "").matchAll(urlPattern)) {
				keys.push(match[1]);
			}
			if (keys.length > 0 && !botMessageTs) {
				botMessageTs = msg.ts;
			}
		}
	}
	return { keys, originalUser, botMessageTs };
}

async function authorizeAction(
	event: SlackMessageEvent,
): Promise<{
	authorized: boolean;
	threadInfo: Awaited<ReturnType<typeof getThreadInfo>>;
}> {
	const threadTs = event.thread_ts;
	if (!threadTs) {
		return {
			authorized: false,
			threadInfo: { keys: [], originalUser: null, botMessageTs: null },
		};
	}

	const threadInfo = await getThreadInfo(event.channel, threadTs);

	const isOriginalUser =
		threadInfo.originalUser && event.user === threadInfo.originalUser;
	const isAdmin = event.user && ADMIN_USERS.includes(event.user);

	if (!isOriginalUser && !isAdmin) {
		await callSlackAPI("reactions.add", {
			channel: event.channel,
			timestamp: event.ts,
			name: "no_entry",
		});
		return { authorized: false, threadInfo };
	}

	return { authorized: true, threadInfo };
}

// --- Event handlers ---

async function handleDeleteRequest(event: SlackMessageEvent) {
	try {
		const { authorized, threadInfo } = await authorizeAction(event);
		if (!authorized) return;

		const { keys, botMessageTs } = threadInfo;
		if (keys.length === 0 || !botMessageTs) return;

		await Promise.all(keys.map((key) => deleteImageFromR2(key)));
		for (const key of keys) deleteImageStats(key);
		await purgeCache(keys);
		console.log(`Deleted ${keys.length} image(s): ${keys.join(", ")}`);

		const strikethroughText = keys
			.map((key) => `~${PUBLIC_URL}/i/${key}~`)
			.join("\n");

		const threadTs = event.thread_ts;
		if (!threadTs) return;

		await Promise.all([
			callSlackAPI("reactions.add", {
				channel: event.channel,
				timestamp: event.ts,
				name: "yay-still",
			}),
			callSlackAPI("chat.update", {
				channel: event.channel,
				ts: botMessageTs,
				text: strikethroughText,
			}),
			callSlackAPI("reactions.add", {
				channel: event.channel,
				timestamp: threadTs,
				name: "boomparrot",
			}),
			callSlackAPI("reactions.remove", {
				channel: event.channel,
				timestamp: threadTs,
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
		const { authorized, threadInfo } = await authorizeAction(event);
		if (!authorized) return;

		const { keys } = threadInfo;
		if (keys.length === 0) return;

		const loadingReaction = callSlackAPI("reactions.add", {
			channel: event.channel,
			timestamp: event.ts,
			name: "spinny_fox",
		});

		const files = event.files || [];
		await Promise.all(
			files.map(async (file, index) => {
				const existingKey = keys[index];
				if (!existingKey) return;
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

				await overwriteImageInR2(existingKey, optimizedBuffer, newContentType);
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
		const text = event.text?.toLowerCase() ?? "";
		const preserveFormat = text.includes("preserve") || text.includes("png");

		const loadingReaction = callSlackAPI("reactions.add", {
			channel: event.channel,
			timestamp: event.ts,
			name: "spinny_fox",
		});

		const filePromises = (event.files || []).map(async (file) => {
			try {
				console.log(`Processing file: ${file.name}`);

				const fileResponse = await fetch(file.url_private, {
					headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
				});

				if (!fileResponse.ok) {
					throw new Error("Failed to download file from Slack");
				}

				const originalBuffer = Buffer.from(await fileResponse.arrayBuffer());
				const contentType = file.mimetype || "image/jpeg";

				console.log(`Downloaded ${file.name} (${originalBuffer.length} bytes)`);

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

				const imageKey = await uploadImageToR2(optimizedBuffer, newContentType);
				console.log(`Uploaded to R2: ${imageKey}`);

				return `${PUBLIC_URL}/i/${imageKey}`;
			} catch (error) {
				console.error(`Error processing file ${file.name}:`, error);
				return null;
			}
		});

		const results = await Promise.all(filePromises);
		const urls = results.filter((url): url is string => url !== null);

		await loadingReaction;

		const apiCalls: Promise<unknown>[] = [
			callSlackAPI("reactions.remove", {
				channel: event.channel,
				timestamp: event.ts,
				name: "spinny_fox",
			}),
		];

		if (urls.length > 0) {
			apiCalls.push(
				callSlackAPI("reactions.add", {
					channel: event.channel,
					timestamp: event.ts,
					name: "yay-still",
				}),
				callSlackAPI("chat.postMessage", {
					channel: event.channel,
					thread_ts: event.ts,
					text: urls.join("\n"),
				}),
			);
		} else {
			apiCalls.push(
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

		await callSlackAPI("reactions.add", {
			channel: event.channel,
			timestamp: event.ts,
			name: "rac-concern",
		}).catch(console.error);
	}
}

// --- Main entry point ---

export async function handleSlackEvent(request: Request): Promise<Response> {
	try {
		const body = await request.text();

		if (!(await verifySlackSignature(request, body))) {
			return new Response("Invalid signature", { status: 401 });
		}

		const payload = JSON.parse(body);

		if (payload.type === "url_verification") {
			return new Response(JSON.stringify({ challenge: payload.challenge }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		if (
			payload.type === "event_callback" &&
			payload.event?.type === "message"
		) {
			const event = payload.event as SlackMessageEvent;

			if (
				ALLOWED_CHANNELS.length > 0 &&
				!ALLOWED_CHANNELS.includes(event.channel)
			) {
				return new Response("OK", { status: 200 });
			}

			const text = (event.text || "").toLowerCase().trim();
			if (event.thread_ts && text === "delete") {
				handleDeleteRequest(event).catch(console.error);
				return new Response("OK", { status: 200 });
			}

			if (event.thread_ts && event.files && event.files.length > 0) {
				handleReplaceRequest(event).catch(console.error);
				return new Response("OK", { status: 200 });
			}

			if (event.thread_ts) {
				return new Response("OK", { status: 200 });
			}

			if (!event.files || event.files.length === 0) {
				return new Response("OK", { status: 200 });
			}

			processSlackFiles(event).catch(console.error);

			return new Response("OK", { status: 200 });
		}

		return new Response("OK", { status: 200 });
	} catch (error) {
		console.error("Error handling Slack event:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
}
