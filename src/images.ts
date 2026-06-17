import { nanoid } from "nanoid";
import sharp from "sharp";

const s3 = new Bun.S3Client({
	accessKeyId:
		process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "",
	secretAccessKey:
		process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
	endpoint: process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT || "",
	bucket: process.env.S3_BUCKET || process.env.AWS_BUCKET || "l4-images",
	region: process.env.S3_REGION || process.env.AWS_REGION || "auto",
});

export async function optimizeImage(
	buffer: Buffer,
	mimeType: string,
	preserveFormat = false,
): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
	if (mimeType === "image/svg+xml") {
		return { buffer, contentType: mimeType, extension: "svg" };
	}

	if (preserveFormat) {
		const extension = mimeType.split("/")[1] || "jpg";
		return { buffer, contentType: mimeType, extension };
	}

	const optimized = await sharp(buffer)
		.webp({ quality: 85, effort: 4 })
		.toBuffer();

	return { buffer: optimized, contentType: "image/webp", extension: "webp" };
}

export async function uploadImageToR2(
	buffer: Buffer,
	contentType: string,
): Promise<string> {
	const mimeToExt: Record<string, string> = {
		"image/svg+xml": "svg",
		"image/webp": "webp",
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
	};
	const extension = mimeToExt[contentType] || "webp";
	const imageKey = `${nanoid(12)}.${extension}`;

	await s3.write(imageKey, buffer, { type: contentType });

	return imageKey;
}

export async function overwriteImageInR2(
	key: string,
	buffer: Buffer,
	contentType: string,
): Promise<void> {
	await s3.write(key, buffer, { type: contentType });
}

export async function deleteImageFromR2(key: string): Promise<void> {
	await s3.delete(key);
}

export { s3 };
