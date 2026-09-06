import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../tas-lab/package.json", import.meta.url));
const { parse } = require("smol-toml");
const MODEL_KEY = "deepseek/deepseek-v4-pro";

export async function loadKimiDeepSeek({ configPath = join(homedir(), ".kimi-code/config.toml") } = {}) {
	let config;
	try {
		config = parse(await readFile(configPath, "utf8"));
	} catch {
		// TOML diagnostics can quote credential lines; never retain the original error.
		throw new Error("Unable to read or parse local Kimi configuration");
	}
	const model = config.models?.[MODEL_KEY];
	const provider = config.providers?.deepseek;
	if (model?.provider !== "deepseek" || model.model !== "deepseek-v4-pro" || provider?.type !== "openai") {
		throw new Error("Expected Kimi deepseek/deepseek-v4-pro with provider deepseek and type openai");
	}
	let base;
	try {
		if (typeof provider.base_url !== "string") throw new Error();
		base = new URL(provider.base_url);
	} catch {
		throw new Error("Invalid configured DeepSeek endpoint");
	}
	if (
		base.origin !== "https://api.deepseek.com" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		!["/", "/v1", "/v1/"].includes(base.pathname)
	) {
		throw new Error("Expected the official DeepSeek API endpoint");
	}
	if (typeof provider.api_key !== "string" || !/^[\x21-\x7e]+$/.test(provider.api_key)) {
		throw new Error("Missing or invalid local DeepSeek API key");
	}
	const contextWindow = model.max_context_size;
	const outputLimit = model.max_output_size;
	if (
		!Number.isSafeInteger(contextWindow) ||
		contextWindow <= 0 ||
		!Number.isSafeInteger(outputLimit) ||
		outputLimit <= 0 ||
		outputLimit > contextWindow
	) {
		throw new Error("Invalid configured DeepSeek context or output limit");
	}
	return {
		apiKey: provider.api_key,
		baseUrl: base.href.replace(/\/$/, ""),
		modelId: model.model,
		contextWindow,
		outputLimit,
	};
}
