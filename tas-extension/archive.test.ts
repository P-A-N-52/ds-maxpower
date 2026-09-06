import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Archive } from "./archive.ts";

function response(input: number, output: number, cacheRead: number, cacheWrite: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Visible reasoning to retain." },
			{ type: "text", text: "42" },
		],
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens: input + output + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

test("late startup, final preparation, and response accounting preserve a cancellation", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "tas-archive-cancel-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const archive = new Archive(cwd, { sessionId: "cancel-test" });
	await archive.save("cancelled", "The user switched TaS off.");
	const lateResponse = response(101, 23, 45, 6);
	lateResponse.stopReason = "aborted";
	await Promise.all([
		archive.start({ messages: ["input whose write settled late"] }),
		archive.save("final", "Preparation continued after cancellation."),
		archive.record("first-1", lateResponse, 345),
	]);
	const manifest = JSON.parse(await readFile(join(archive.directory, "run.json"), "utf8"));
	assert.equal(manifest.status, "cancelled");
	assert.equal(manifest.reason, "The user switched TaS off.");
	assert.equal(manifest.sessionId, "cancel-test");
	assert.deepEqual(manifest.usage, { input: 101, output: 23, cacheRead: 45, cacheWrite: 6 });
	assert.equal(manifest.calls.length, 1);
	assert.equal(manifest.calls[0].phase, "first-1");
	assert.equal(manifest.calls[0].stopReason, "aborted");
	const savedResponse = JSON.parse(await readFile(join(archive.directory, "1-first-1.json"), "utf8"));
	assert.deepEqual(savedResponse.usage, lateResponse.usage);
	assert.equal(savedResponse.elapsedMs, 345);
});

test("a completed run retains both independent attempts and final usage without losing cache accounting", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "tas-archive-complete-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const archive = new Archive(cwd, { sessionId: "completed-test", samples: 2 });
	await archive.start({ systemPrompt: "system", messages: ["source and question"] });
	await archive.record("first-1", response(100, 20, 30, 4), 101);
	await archive.record("first-2", response(50, 21, 80, 3), 102);
	await archive.save("final");
	await archive.record("final", response(200, 40, 70, 2), null);
	await archive.save("completed");
	const manifest = JSON.parse(await readFile(join(archive.directory, "run.json"), "utf8"));
	assert.equal(manifest.status, "completed");
	assert.deepEqual(manifest.usage, { input: 350, output: 81, cacheRead: 180, cacheWrite: 9 });
	assert.deepEqual(
		manifest.calls.map((call: { phase: string }) => call.phase),
		["first-1", "first-2", "final"],
	);
	assert.deepEqual(
		manifest.calls.map((call: { elapsedMs: number | null }) => call.elapsedMs),
		[101, 102, null],
	);
	const files = await readdir(archive.directory);
	assert.ok(files.includes("1-first-1.json"));
	assert.ok(files.includes("2-first-2.json"));
	assert.ok(files.includes("3-final.json"));
	assert.equal(
		files.some((file) => file.endsWith(".tmp")),
		false,
	);
});

test("provider error bodies are excluded while visible response content and measured usage remain archived", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "tas-archive-redaction-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const archive = new Archive(cwd, { sessionId: "redaction-test" });
	await archive.start({ messages: ["safe task input"] });
	const failed = response(12, 3, 4, 0);
	failed.stopReason = "error";
	failed.errorMessage = "Remote error body: Authorization Bearer SYNTHETIC_PROVIDER_SECRET_DO_NOT_ARCHIVE";
	await archive.record("first-1", failed, 10);
	await archive.save("failed", "The provider request did not complete.");
	const files = await readdir(archive.directory);
	const contents = await Promise.all(files.map((file) => readFile(join(archive.directory, file), "utf8")));
	assert.doesNotMatch(contents.join("\n"), /SYNTHETIC_PROVIDER_SECRET_DO_NOT_ARCHIVE/);
	assert.doesNotMatch(contents.join("\n"), /Remote error body/);
	const savedResponse = JSON.parse(await readFile(join(archive.directory, "1-first-1.json"), "utf8"));
	assert.equal("errorMessage" in savedResponse, false);
	assert.deepEqual(savedResponse.content, failed.content);
	assert.deepEqual(savedResponse.usage, failed.usage);
	assert.equal(savedResponse.stopReason, "error");
});
