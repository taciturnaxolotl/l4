const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";
const CF_ZONE_ID = process.env.CF_ZONE_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";

export async function purgeCache(keys: string[]) {
	if (!CF_ZONE_ID || !CF_API_TOKEN) return;
	// `/i/:key` is a 307 that Cloudflare bypasses; the cached copy lives at the
	// R2 custom domain, so that URL is the one that actually has to be purged.
	const urls = keys.flatMap((key) =>
		R2_PUBLIC_URL
			? [`${R2_PUBLIC_URL}/${key}`, `${PUBLIC_URL}/i/${key}`]
			: [`${PUBLIC_URL}/i/${key}`],
	);

	// Wait for R2 write propagation before purging
	await new Promise((r) => setTimeout(r, 5000));

	// Cloudflare takes at most 30 files per purge request.
	for (let i = 0; i < urls.length; i += 30) {
		const batch = urls.slice(i, i + 30);
		try {
			const res = await fetch(
				`https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${CF_API_TOKEN}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ files: batch }),
				},
			);
			const data = await res.json();
			if (!data.success) {
				console.error("Cache purge failed:", JSON.stringify(data.errors));
			} else {
				console.log(`Cache purged: ${batch.join(", ")}`);
			}
		} catch (err) {
			console.error("Cache purge failed:", err);
		}
	}
}
