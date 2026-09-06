import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadKimiDeepSeek } from "./kimi-config.mjs";
import { assertNoStoredDeepSeekCredential } from "./launch.mjs";

const KEY = "synthetic-secret-for-tests";
const CONFIG = `[providers.deepseek]
type = "openai"
base_url = "https://api.deepseek.com"
api_key = "${KEY}"
[models."deepseek/deepseek-v4-pro"]
provider = "deepseek"
model = "deepseek-v4-pro"
max_context_size = 1000000
max_output_size = 32768
`;

async function temporary(run) {
	const directory = await mkdtemp(join(tmpdir(), "tas-kimi-config-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("loads only the selected official model and leaves the source untouched", () =>
	temporary(async (directory) => {
		const configPath = join(directory, "config.toml");
		await writeFile(configPath, CONFIG);
		assert.deepEqual(await loadKimiDeepSeek({ configPath }), {
			apiKey: KEY,
			baseUrl: "https://api.deepseek.com",
			modelId: "deepseek-v4-pro",
			contextWindow: 1000000,
			outputLimit: 32768,
		});
		assert.equal(await readFile(configPath, "utf8"), CONFIG);
	}));

test("rejects configuration errors without including source lines or credentials", () =>
	temporary(async (directory) => {
		const configPath = join(directory, "config.toml");
		const variants = [
			CONFIG.replace(`api_key = "${KEY}"`, `api_key = "${KEY}`),
			CONFIG.replace("https://api.deepseek.com", `invalid-${KEY}`),
			CONFIG.replace("https://api.deepseek.com", `https://${KEY}@api.deepseek.com`),
			CONFIG.replace("https://api.deepseek.com", "https://example.com"),
			CONFIG.replace("https://api.deepseek.com", "https://api.deepseek.com/other"),
			CONFIG.replace("https://api.deepseek.com", `https://api.deepseek.com?token=${KEY}`),
			CONFIG.replace('type = "openai"', 'type = "openai_responses"'),
			CONFIG.replace('model = "deepseek-v4-pro"', 'model = "another-model"'),
			CONFIG.replace("max_output_size = 32768", "max_output_size = 1000001"),
			CONFIG.replace(`api_key = "${KEY}"`, 'api_key = ""'),
		];
		for (const config of variants) {
			await writeFile(configPath, config);
			await assert.rejects(loadKimiDeepSeek({ configPath }), (error) => {
				assert.equal(error.message.includes(KEY), false);
				assert.equal(error.message.includes("api_key ="), false);
				assert.equal(error.cause, undefined);
				return true;
			});
		}
	}));

test("profile check refuses stored DeepSeek credentials and hides malformed auth content", () =>
	temporary(async (directory) => {
		await assertNoStoredDeepSeekCredential(directory);
		const authPath = join(directory, "auth.json");
		await writeFile(authPath, JSON.stringify({ deepseek: { type: "api_key", key: KEY } }));
		await assert.rejects(assertNoStoredDeepSeekCredential(directory), /already contains a DeepSeek credential/);
		await writeFile(authPath, `{ "deepseek": "${KEY}`);
		await assert.rejects(assertNoStoredDeepSeekCredential(directory), (error) => {
			assert.equal(error.message.includes(KEY), false);
			return true;
		});
		await writeFile(authPath, "{}");
		await assertNoStoredDeepSeekCredential(directory);
	}));
