import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assertBudget, fingerprint, freezeMessages, serializeTraces } from "./protocol.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function response(thinking: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text: "ANSWER_NOT_A_TRACE" },
		],
		api: "openai-completions",
		provider: "deepseek",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 2,
	};
}

test("freezes latest-user file references once while preserving history, roles, and input", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "tas-protocol-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "source.txt"), "source α\n");
	await writeFile(join(cwd, "with space.txt"), "second source");
	const priorAssistant = response("old reasoning");
	priorAssistant.content = [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "old" } }];
	priorAssistant.stopReason = "toolUse";
	const messages: AgentMessage[] = [
		user("Historical @missing.txt must not be reread"),
		priorAssistant,
		{
			role: "toolResult",
			toolCallId: "read-1",
			toolName: "read",
			content: [{ type: "text", text: "old result" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "user",
			content: [{ type: "text", text: 'Compare @source.txt @"with space.txt" @./source.txt' }],
			timestamp: 4,
		},
	];
	const original = structuredClone(messages);
	const result = await freezeMessages(messages, cwd);
	assert.deepEqual(messages, original);
	assert.deepEqual(result.messages.slice(0, 3), original.slice(0, 3));
	assert.deepEqual(
		result.files.map((file) => file.path),
		[join(cwd, "source.txt"), join(cwd, "with space.txt")],
	);
	assert.equal(result.files[0].sha256, createHash("sha256").update("source α\n").digest("hex"));
	assert.equal(result.files[0].bytes, Buffer.byteLength("source α\n"));
	const question = result.messages[3];
	assert.equal(question.role, "user");
	if (question.role !== "user" || !Array.isArray(question.content)) throw new Error("Expected user text blocks");
	assert.equal(question.content.length, 2);
	assert.deepEqual(question.content[1], { type: "text", text: 'Compare @source.txt @"with space.txt" @./source.txt' });
	assert.match(JSON.stringify(question.content[0]), /source α/);
	await writeFile(join(cwd, "source.txt"), "changed later");
	assert.doesNotMatch(JSON.stringify(result.messages), /changed later/);
});

test("does not interpret email addresses or embedded at-signs as file mentions", async () => {
	const messages = [user("Email a@example.com and object@field are ordinary text.")];
	const frozen = await freezeMessages(messages, tmpdir());
	assert.deepEqual(frozen, { messages, files: [] });
	assert.notEqual(frozen.messages, messages);
});

test("rejects invalid UTF-8, binary, directory, missing, and oversized file snapshots", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "tas-protocol-invalid-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "invalid"), Buffer.from([0xc3, 0x28]));
	await writeFile(join(cwd, "binary"), Buffer.from([65, 0, 66]));
	await writeFile(join(cwd, "large"), "x".repeat(256 * 1024 + 1));
	await mkdir(join(cwd, "folder"));
	await assert.rejects(freezeMessages([user("@invalid")], cwd), /not valid UTF-8/);
	await assert.rejects(freezeMessages([user("@binary")], cwd), /binary/);
	await assert.rejects(freezeMessages([user("@large")], cwd), /exceeds 256 KiB/);
	await assert.rejects(freezeMessages([user("@folder")], cwd), /not a regular file/);
	await assert.rejects(freezeMessages([user("@missing")], cwd), /ENOENT/);
});

test("accepts exact file-size limits but rejects a total exceeding 512 KiB", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "tas-protocol-limits-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "a"), "a".repeat(256 * 1024));
	await writeFile(join(cwd, "b"), "b".repeat(256 * 1024));
	await writeFile(join(cwd, "c"), "c");
	const result = await freezeMessages([user("@a @b")], cwd);
	assert.equal(
		result.files.reduce((total, file) => total + file.bytes, 0),
		512 * 1024,
	);
	await assert.rejects(freezeMessages([user("@a @b @c")], cwd), /exceed 512 KiB/);
});

test("rejects images anywhere in retained context and rejects missing user input", async () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 },
		user("A later text question"),
	];
	await assert.rejects(freezeMessages(messages, tmpdir()), /text context only/);
	await assert.rejects(freezeMessages([response("thought")], tmpdir()), /requires a user message/);
});

test("serializes reasoning only and marks code-point truncation without splitting astral characters", () => {
	const responses = [response("🧠".repeat(50_001)), response("valid next attempt")];
	const before = structuredClone(responses);
	const output = serializeTraces(responses);
	const payload = JSON.parse(output.slice(output.indexOf("\n") + 1));
	assert.equal(payload.traces[0].originalCharacters, 50_001);
	assert.equal(payload.traces[0].includedCharacters, 50_000);
	assert.equal(payload.traces[0].truncated, true);
	assert.equal(Array.from(payload.traces[0].thinking).length, 50_000);
	assert.equal(payload.traces[0].thinking, "🧠".repeat(50_000));
	assert.equal(payload.traces[1].truncated, false);
	assert.match(output, /untrusted reasoning/);
	assert.match(output, /not tokens/);
	assert.doesNotMatch(output, /ANSWER_NOT_A_TRACE/);
	assert.deepEqual(responses, before);
});

test("only complete responses containing visible reasoning may become traces", () => {
	assert.throws(() => serializeTraces([]), /at least one/);
	for (const reason of ["length", "error", "aborted", "toolUse", "deferred", "pending"] as const) {
		assert.throws(() => serializeTraces([response("partial", reason)]), /did not complete normally/);
	}
	assert.throws(() => serializeTraces([response(" \n\t")]), /no visible reasoning/);
	const redacted = response("opaque");
	redacted.content = [{ type: "thinking", thinking: "opaque", redacted: true }];
	assert.throws(() => serializeTraces([redacted]), /no visible reasoning/);
});

test("budget accounts for UTF-8 serialization, tool schemas, output reserve, and framework allowance", () => {
	const messages = [user("中文 🧠")];
	const tools = [{ name: "read", parameters: { path: "string" } }];
	const expected = Buffer.byteLength(JSON.stringify({ systemPrompt: "system", messages, tools }), "utf8") + 4096;
	assert.deepEqual(assertBudget("system", messages, tools, 100_000, 8192), { estimatedInput: expected, limit: 80_000 });
	const limit = 8000;
	assertBudget("system", messages, tools, 10_000, limit - expected);
	assert.throws(
		() => assertBudget("system", messages, tools, 10_000, limit - expected + 1),
		/not an exact tokenizer count/,
	);
	assert.throws(() => assertBudget("", [], [], Number.POSITIVE_INFINITY, 1), /valid context window/);
	assert.throws(() => assertBudget("", [], [], 100_000, -1), /valid output reserve/);
});

test("fingerprint is SHA-256 of the complete JSON representation", () => {
	const value = { text: "中文", roles: ["user", "assistant"] };
	assert.equal(fingerprint(value), createHash("sha256").update(JSON.stringify(value)).digest("hex"));
	assert.notEqual(fingerprint(value), fingerprint({ ...value, text: "changed" }));
	assert.throws(() => fingerprint(undefined), /not JSON serializable/);
});
