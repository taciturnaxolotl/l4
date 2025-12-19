#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".config", "l4");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
	apiKey?: string;
	baseUrl?: string;
}

async function loadConfig(): Promise<Config> {
	if (!existsSync(CONFIG_FILE)) {
		return {};
	}
	const data = await readFile(CONFIG_FILE, "utf-8");
	return JSON.parse(data);
}

async function saveConfig(config: Config): Promise<void> {
	const { mkdir } = await import("fs/promises");
	await mkdir(CONFIG_DIR, { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function getConfig(): Promise<Config> {
	const config = await loadConfig();
	if (!config.apiKey || !config.baseUrl) {
		console.error(
			chalk.red("Error: Not configured. Run 'l4 config' first."),
		);
		process.exit(1);
	}
	return config;
}

const program = new Command();

program
	.name("l4")
	.description("CLI for L4 image cache")
	.version("1.0.0");

program
	.command("config")
	.description("Configure L4 CLI")
	.option("-k, --api-key <key>", "API key")
	.option("-u, --url <url>", "Base URL")
	.action(async (options) => {
		const config = await loadConfig();

		if (options.apiKey) {
			config.apiKey = options.apiKey;
		}

		if (options.url) {
			config.baseUrl = options.url;
		}

		if (!options.apiKey && !options.url) {
			console.log(chalk.blue("Current configuration:"));
			console.log(
				`API Key: ${config.apiKey ? chalk.green("Set") : chalk.red("Not set")}`,
			);
			console.log(
				`Base URL: ${config.baseUrl ? chalk.green(config.baseUrl) : chalk.red("Not set")}`,
			);
			console.log(
				`\nRun ${chalk.cyan("l4 config --api-key <key> --url <url>")} to configure.`,
			);
			return;
		}

		await saveConfig(config);
		console.log(chalk.green("✓ Configuration saved"));
	});

program
	.command("upload <file>")
	.description("Upload an image")
	.option("-k, --key <key>", "Custom key for the image")
	.action(async (filePath: string, options) => {
		const config = await getConfig();
		const spinner = ora("Uploading image...").start();

		try {
			const fileData = await readFile(filePath);
			const fileName = filePath.split("/").pop() || "image";

			const formData = new FormData();
			const blob = new Blob([fileData]);
			formData.append("file", blob, fileName);

			if (options.key) {
				formData.append("key", options.key);
			}

			const response = await fetch(`${config.baseUrl}/api/upload`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: formData,
			});

			if (!response.ok) {
				const error = await response.json();
				throw new Error(error.error || "Upload failed");
			}

			const result = await response.json();
			spinner.succeed("Image uploaded successfully");

			console.log(chalk.blue("\nImage URL:"));
			console.log(chalk.cyan(result.url));
			console.log(chalk.gray(`Key: ${result.key}`));
		} catch (error: any) {
			spinner.fail("Upload failed");
			console.error(chalk.red(error.message));
			process.exit(1);
		}
	});

program
	.command("list")
	.description("List all images")
	.option("-l, --limit <number>", "Number of images to list", "100")
	.action(async (options) => {
		const config = await getConfig();
		const spinner = ora("Fetching images...").start();

		try {
			const response = await fetch(
				`${config.baseUrl}/api/images?limit=${options.limit}`,
				{
					headers: {
						Authorization: `Bearer ${config.apiKey}`,
					},
				},
			);

			if (!response.ok) {
				throw new Error("Failed to fetch images");
			}

			const data = await response.json();
			spinner.succeed(`Found ${data.images.length} images`);

			if (data.images.length === 0) {
				console.log(chalk.gray("No images found"));
				return;
			}

			console.log();
			for (const image of data.images) {
				console.log(chalk.cyan(image.key));
				console.log(chalk.gray(`  ${image.originalName}`));
				console.log(
					chalk.gray(
						`  ${(image.size / 1024).toFixed(2)} KB • ${new Date(image.uploadedAt).toLocaleDateString()}`,
					),
				);
				console.log(chalk.blue(`  ${config.baseUrl}/i/${image.key}`));
				console.log();
			}

			if (data.hasMore) {
				console.log(chalk.yellow("More images available (use --limit to see more)"));
			}
		} catch (error: any) {
			spinner.fail("Failed to fetch images");
			console.error(chalk.red(error.message));
			process.exit(1);
		}
	});

program
	.command("delete <key>")
	.description("Delete an image")
	.action(async (key: string) => {
		const config = await getConfig();
		const spinner = ora("Deleting image...").start();

		try {
			const response = await fetch(`${config.baseUrl}/api/images/${key}`, {
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
			});

			if (!response.ok) {
				throw new Error("Failed to delete image");
			}

			spinner.succeed("Image deleted successfully");
		} catch (error: any) {
			spinner.fail("Delete failed");
			console.error(chalk.red(error.message));
			process.exit(1);
		}
	});

program
	.command("url <key>")
	.description("Get URL for an image")
	.option("-w, --width <width>", "Image width")
	.option("-h, --height <height>", "Image height")
	.option("-f, --format <format>", "Image format (auto, webp, avif, jpeg)")
	.option("-q, --quality <quality>", "Image quality (1-100)")
	.action(async (key: string, options) => {
		const config = await getConfig();
		const url = new URL(`/i/${key}`, config.baseUrl);

		if (options.width) url.searchParams.set("w", options.width);
		if (options.height) url.searchParams.set("h", options.height);
		if (options.format) url.searchParams.set("f", options.format);
		if (options.quality) url.searchParams.set("q", options.quality);

		console.log(chalk.cyan(url.toString()));
	});

program.parse();
