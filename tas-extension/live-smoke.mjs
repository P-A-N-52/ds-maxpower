import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore } from "../pi/packages/ai/src/index.ts";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../pi/packages/coding-agent/src/index.ts";
import { loadKimiDeepSeek } from "./kimi-config.mjs";

// Explicitly invoked, bounded paid acceptance test. Ordinary `npm test` never runs this.
if (!process.argv.includes("--live")) throw new Error("Use --live to run the paid DeepSeek smoke test.");
const directory = fileURLToPath(new URL(`./runs/${new Date().toISOString().replaceAll(":", "-")}/`, import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(join(directory, "fixture.txt"), "a=19\nb=23\n", { mode: 0o600 });
const config = await loadKimiDeepSeek();
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	assert.equal(url.origin, "https://api.deepseek.com");
	assert.ok(url.pathname.endsWith("/chat/completions"));
	assert.ok(requests.length < 4, "smoke test allows at most four paid requests");
	const payload = await request.clone().json();
	assert.equal(payload.model, config.modelId);
	assert.equal(payload.thinking?.type, "enabled");
	assert.equal(payload.reasoning_effort, "max");
	assert.equal(payload.max_tokens, 32768);
	requests.push(payload);
	return originalFetch(request);
};

const modelRuntime = await ModelRuntime.create({
	credentials: new InMemoryCredentialStore(),
	modelsPath: null,
	allowModelNetwork: false,
});
await modelRuntime.setRuntimeApiKey("deepseek", config.apiKey);
const model = modelRuntime.getModel("deepseek", config.modelId);
assert.ok(model);
const abortController = new AbortController();
abortController.abort();
const aborted = await modelRuntime.complete(
	model,
	{ messages: [{ role: "user", content: "unused", timestamp: 0 }] },
	{
		signal: abortController.signal,
		maxTokens: 32768,
		reasoningEffort: "max",
		maxRetries: 0,
	},
);
assert.ok(["error", "aborted"].includes(aborted.stopReason));
assert.equal(requests.length, 0, "pre-aborted provider calls must not reach HTTP");

const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const sessionManager = SessionManager.inMemory(directory);
const resourceLoader = new DefaultResourceLoader({
	cwd: directory,
	agentDir: directory,
	settingsManager,
	additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
const { session } = await createAgentSession({
	cwd: directory,
	agentDir: directory,
	settingsManager,
	sessionManager,
	resourceLoader,
	modelRuntime,
	model,
	thinkingLevel: "max",
	tools: ["read"],
});
const errors = [];
let reads = 0;
session.subscribe((event) => {
	if (event.type === "tool_execution_end" && event.toolName === "read" && !event.isError) reads++;
});
await session.bindExtensions({ mode: "print", onError: () => errors.push("extension error") });
const timeout = setTimeout(() => void session.abort(), 180_000);
const started = performance.now();
try {
	await session.prompt("/tas on");
	await session.prompt(
		"Compute a+b from @fixture.txt using its contents. In the final tool-enabled pass, call read exactly once to verify fixture.txt, then answer with only the number. During a tool-free attempt, use the supplied frozen snapshot.",
	);
	assert.deepEqual(errors, []);
	assert.equal(requests.length, 4, "two independent first passes, a tool call, and the final answer");
	assert.equal(reads, 1);
	assert.deepEqual(requests[0].messages, requests[1].messages);
	assert.equal(requests[0].tools?.length ?? 0, 0);
	assert.equal(requests[1].tools?.length ?? 0, 0);
	const final = session.messages.findLast((message) => message.role === "assistant");
	assert.equal(final?.stopReason, "stop");
	const answer = final.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	assert.equal(answer, "42");
	const trace = requests[2].messages.find((message) => message.role === "user").content;
	assert.ok(trace.includes("untrusted reasoning"));
	assert.equal(requests[3].messages.find((message) => message.role === "user").content, trace);
	assert.ok(!JSON.stringify(session.messages).includes("untrusted reasoning"));
	const runIds = await readdir(join(directory, ".pi", "tas"));
	assert.equal(runIds.length, 1);
	const manifest = JSON.parse(await readFile(join(directory, ".pi", "tas", runIds[0], "run.json"), "utf8"));
	assert.equal(manifest.status, "completed");
	assert.equal(manifest.calls.length, 4);
	const report = {
		passed: true,
		model: model.id,
		api: model.api,
		calls: requests.length,
		reads,
		answer,
		cancelledRequestReachedHttp: false,
		elapsedMs: Math.round(performance.now() - started),
		usage: manifest.usage,
		archive: join(directory, ".pi", "tas", runIds[0]),
	};
	await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
	await writeFile(join(directory, "requests.json"), `${JSON.stringify(requests, null, 2)}\n`, { mode: 0o600 });
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	await writeFile(
		join(directory, "report.json"),
		`${JSON.stringify(
			{
				passed: false,
				calls: requests.length,
				reads,
				elapsedMs: Math.round(performance.now() - started),
				reason: "Acceptance failed; inspect the run archive and assertion output.",
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	throw error;
} finally {
	clearTimeout(timeout);
	session.dispose();
	globalThis.fetch = originalFetch;
}
