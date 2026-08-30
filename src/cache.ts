const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";
const CF_ZONE_ID = process.env.CF_ZONE_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";

export async function purgeCache(keys: string[]) {
	if (!CF_ZONE_ID || !CF_API_TOKEN) return;
	const urls = keys.map((key) => `${PUBLIC_URL}/i/${key}`);

	// Wait for R2 write propagation before purging
	await new Promise((r) => setTimeout(r, 5000));

	try {
		const res = await fetch(
			`https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${CF_API_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ files: urls }),
			},
		);
		const data = await res.json();
		if (!data.success) {
			console.error("Cache purge failed:", JSON.stringify(data.errors));
		} else {
			console.log(`Cache purged: ${urls.join(", ")}`);
		}
	} catch (err) {
		console.error("Cache purge failed:", err);
	}
}
