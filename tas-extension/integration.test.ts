import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Type } from "../pi/node_modules/typebox/build/index.mjs";
import {
	type Context,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	InMemoryCredentialStore,
	type Message,
	type SimpleStreamOptions,
} from "../pi/packages/ai/src/index.ts";
import {
	createAgentSession,
	DefaultResourceLoader,
	type InlineExtension,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "../pi/packages/coding-agent/src/index.ts";

process.env.PI_OFFLINE = "1";

const extensionPath = process.env.TAS_PACKAGE_DIR
	? join(process.env.TAS_PACKAGE_DIR, "tas-extension", "index.ts")
	: fileURLToPath(new URL("./index.ts", import.meta.url));
const extensionSource = process.env.TAS_PACKAGE_DIR ?? extensionPath;
const question = "x: SOURCE_SENTINEL says the answer is 42.\nq: QUESTION_SENTINEL asks for the answer.";
const firstTrace = "FIRST_TRACE_SENTINEL: independently inspect the source and derive 42.";
const secondTrace = "SECOND_TRACE_SENTINEL: check the first principles and verify the answer is 42.";

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : part.type === "thinking" ? [part.thinking] : []))
		.join("\n");
}

function firstAttempt(trace: string) {
	return fauxAssistantMessage([fauxThinking(trace), fauxText("42")]);
}

function snapshotContext(context: Context): Context {
	return {
		...context,
		messages: structuredClone(context.messages),
		tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
	};
}

async function createIntegrationSession(
	t: TestContext,
	options: {
		customTools?: ToolDefinition[];
		extensionFactories?: InlineExtension[];
	} = {},
) {
	const customTools = options.customTools ?? [];
	const directory = await mkdtemp(join(tmpdir(), "tas-integration-"));
	let dispose = () => {};
	t.after(async () => {
		dispose();
		await rm(directory, { recursive: true, force: true });
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const sessionManager = SessionManager.inMemory(directory);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		provider: "deepseek",
		api: "openai-completions",
		models: [{ id: "deepseek-v4-pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 32768 }],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager,
		additionalExtensionPaths: [extensionSource],
		extensionFactories: options.extensionFactories,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, [], "the real extension loader must load the entrypoint");
	assert.ok(loader.getExtensions().extensions.some((extension) => extension.resolvedPath === extensionPath));
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		settingsManager,
		sessionManager,
		resourceLoader: loader,
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "medium",
		noTools: customTools.length ? "builtin" : "all",
		customTools,
	});
	dispose = () => session.dispose();
	const extensionErrors: string[] = [];
	await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error.error) });
	return { session, sessionManager, settingsManager, directory, faux, extensionErrors };
}

test("the real loader starts TaS off and leaves an ordinary prompt at one provider call", async (t) => {
	const { session, faux, extensionErrors } = await createIntegrationSession(t);
	let received: Context | undefined;
	faux.setResponses([
		(context) => {
			received = snapshotContext(context);
			return fauxAssistantMessage("ordinary answer");
		},
	]);
	await session.prompt("/tas status");
	assert.equal(faux.state.callCount, 0);
	await session.prompt(question);
	assert.equal(faux.state.callCount, 1);
	assert.deepEqual(received?.messages.map(messageText), [question]);
	assert.deepEqual(extensionErrors, []);
});

test("TaS on takes two independent samples and prefixes the final request without persisting trajectories", async (t) => {
	const { session, sessionManager, faux, extensionErrors } = await createIntegrationSession(t);
	const requests: Context[] = [];
	const optionsSeen: Array<SimpleStreamOptions | undefined> = [];
	const responses = [
		firstAttempt(firstTrace),
		firstAttempt(secondTrace),
		fauxAssistantMessage("FINAL_ANSWER_SENTINEL: 42"),
	];
	faux.setResponses(
		responses.map((response) => (context, options) => {
			requests.push(snapshotContext(context));
			optionsSeen.push(options);
			return response;
		}),
	);
	await session.prompt("/tas on");
	await session.prompt("/tas status");
	assert.equal(faux.state.callCount, 0);
	await session.prompt(question);
	assert.equal(faux.state.callCount, 3);
	assert.equal(session.thinkingLevel, "medium", "TaS must not change the session thinking setting");
	assert.deepEqual(requests[0].messages, requests[1].messages, "first attempts must see the same frozen input");
	assert.deepEqual(requests[0].messages.map(messageText), [question]);
	assert.equal(requests[0].tools?.length ?? 0, 0);
	assert.equal(requests[1].tools?.length ?? 0, 0);
	for (const options of optionsSeen.slice(0, 2)) {
		assert.equal(options?.maxTokens, 32768);
		assert.equal((options as SimpleStreamOptions & { reasoningEffort?: string })?.reasoningEffort, "max");
	}
	assert.equal(requests[2].messages[0].role, "user");
	assert.ok(messageText(requests[2].messages[0]).includes(firstTrace));
	assert.ok(messageText(requests[2].messages[0]).includes(secondTrace));
	assert.deepEqual(requests[2].messages.slice(1), requests[0].messages, "the unchanged x/q follows T");
	const persisted = JSON.stringify(sessionManager.getBranch());
	assert.ok(persisted.includes("FINAL_ANSWER_SENTINEL"));
	assert.ok(!persisted.includes("FIRST_TRACE_SENTINEL"));
	assert.ok(!persisted.includes("SECOND_TRACE_SENTINEL"));
	assert.ok(!JSON.stringify(session.messages).includes("FIRST_TRACE_SENTINEL"));
	assert.deepEqual(extensionErrors, []);

	let afterOffContext: Context | undefined;
	faux.setResponses([
		(context) => {
			afterOffContext = snapshotContext(context);
			return fauxAssistantMessage("ordinary again");
		},
	]);
	await session.prompt("/tas off");
	await session.prompt("ordinary follow-up");
	assert.equal(faux.state.callCount, 4, "off restores a single ordinary provider call");
	assert.ok(afterOffContext);
	assert.ok(!JSON.stringify(afterOffContext.messages).includes("FIRST_TRACE_SENTINEL"));
});

for (const stopReason of ["error", "length"] as const) {
	test(`a first attempt ending with ${stopReason} aborts before any final request`, async (t) => {
		const { session, faux } = await createIntegrationSession(t);
		const terminalSignals: boolean[] = [];
		faux.setResponses([
			fauxAssistantMessage([fauxThinking("INCOMPLETE_TRACE_SENTINEL"), fauxText("partial")], {
				stopReason,
				...(stopReason === "error" ? { errorMessage: "deliberate offline provider failure" } : {}),
			}),
			(_context, options) => {
				terminalSignals.push(options?.signal?.aborted ?? false);
				return fauxAssistantMessage("UNREACHABLE_FINAL_SENTINEL");
			},
		]);
		await session.prompt("/tas on");
		await session.prompt(question);
		assert.equal(faux.state.callCount, 1 + terminalSignals.length);
		// Pi invokes its stream function even after transformContext aborts. The
		// faux function counts that invocation; only a live final request is wrong.
		assert.ok(terminalSignals.every(Boolean), "any final stream invocation must already be cancelled");
		assert.ok(!JSON.stringify(session.messages).includes("UNREACHABLE_FINAL_SENTINEL"));
	});
}

test(
	"aborting the session cancels a pending first attempt and never starts the final request",
	{ timeout: 10_000 },
	async (t) => {
		const { session, faux } = await createIntegrationSession(t);
		const started = Promise.withResolvers<AbortSignal>();
		let wasCancelled = false;
		const terminalSignals: boolean[] = [];
		faux.setResponses([
			async (_context, options) => {
				assert.ok(options?.signal, "first attempts must receive the real agent cancellation signal");
				const signal = options.signal;
				started.resolve(signal);
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				wasCancelled = true;
				return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
			},
			(_context, options) => {
				terminalSignals.push(options?.signal?.aborted ?? false);
				return fauxAssistantMessage("UNREACHABLE_FINAL_SENTINEL");
			},
		]);
		await session.prompt("/tas on");
		const pending = session.prompt(question);
		const signal = await started.promise;
		await session.abort();
		await pending;
		assert.equal(signal.aborted, true);
		assert.equal(wasCancelled, true);
		assert.equal(faux.state.callCount, 1 + terminalSignals.length);
		assert.ok(terminalSignals.every(Boolean), "cancellation must prevent an active final request");
		assert.ok(!JSON.stringify(session.messages).includes("UNREACHABLE_FINAL_SENTINEL"));
	},
);

test("tool continuations reuse one trajectory prefix and a new user message samples again", async (t) => {
	const executed: string[] = [];
	const parameters = Type.Object({ text: Type.String() });
	const echoTool: ToolDefinition<typeof parameters> = {
		name: "echo",
		label: "Echo",
		description: "Return the supplied text for offline integration testing.",
		parameters,
		async execute(_id, parameters) {
			executed.push(parameters.text);
			return { content: [{ type: "text", text: parameters.text }], details: {} };
		},
	};
	const { session, faux, extensionErrors } = await createIntegrationSession(t, { customTools: [echoTool] });
	const requests: Context[] = [];
	const responses = [
		firstAttempt(firstTrace),
		firstAttempt(secondTrace),
		fauxAssistantMessage([fauxToolCall("echo", { text: "TOOL_RESULT_SENTINEL" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("first task done"),
		firstAttempt("NEW_TASK_FIRST_TRACE_SENTINEL: reason about the new question independently."),
		firstAttempt("NEW_TASK_SECOND_TRACE_SENTINEL: check the new question independently."),
		fauxAssistantMessage("second task done"),
	];
	faux.setResponses(
		responses.map((response) => (context) => {
			requests.push(snapshotContext(context));
			return response;
		}),
	);
	await session.prompt("/tas on");
	await session.prompt(question);
	assert.deepEqual(
		executed,
		["TOOL_RESULT_SENTINEL"],
		JSON.stringify({
			calls: faux.state.callCount,
			extensionErrors,
			messages: session.messages,
		}),
	);
	assert.equal(faux.state.callCount, 4, "a tool continuation must not repeat the two first attempts");
	assert.deepEqual(requests[3].messages[0], requests[2].messages[0]);
	assert.ok(
		requests[3].messages.some(
			(message) => message.role === "toolResult" && messageText(message).includes("TOOL_RESULT_SENTINEL"),
		),
	);
	await session.prompt("NEW_USER_QUESTION_SENTINEL: what is 6 times 7?");
	assert.equal(faux.state.callCount, 7);
	assert.deepEqual(requests[4].messages, requests[5].messages);
	assert.ok(!JSON.stringify(requests[4].messages).includes("FIRST_TRACE_SENTINEL"));
	assert.ok(messageText(requests[6].messages[0]).includes("NEW_TASK_FIRST_TRACE_SENTINEL"));
	assert.deepEqual(requests[6].messages.slice(1), requests[4].messages);
	assert.deepEqual(extensionErrors, []);
});

test("a separately loaded fresh session starts off even after another session enabled TaS", async (t) => {
	const previous = await createIntegrationSession(t);
	await previous.session.prompt("/tas on");
	const current = await createIntegrationSession(t);
	current.faux.setResponses([fauxAssistantMessage("new session ordinary answer")]);
	await current.session.prompt(question);
	assert.equal(current.faux.state.callCount, 1);
	assert.deepEqual(current.extensionErrors, []);
});

test(
	"switching TaS off during a first attempt cancels it and accepts an ordinary follow-up",
	{ timeout: 10_000 },
	async (t) => {
		const { session, faux, extensionErrors } = await createIntegrationSession(t);
		const started = Promise.withResolvers<AbortSignal>();
		const ordinaryRequests: Context[] = [];
		const afterCancellation = (context: Context, options?: SimpleStreamOptions) => {
			if (options?.signal?.aborted) return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
			ordinaryRequests.push(snapshotContext(context));
			return fauxAssistantMessage("ORDINARY_AFTER_OFF_SENTINEL");
		};
		faux.setResponses([
			async (_context, options) => {
				assert.ok(options?.signal);
				const signal = options.signal;
				started.resolve(signal);
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
			},
			afterCancellation,
			afterCancellation,
		]);
		await session.prompt("/tas on");
		const pending = session.prompt(question);
		const signal = await started.promise;
		await session.prompt("/tas off");
		const ordinary = session.prompt("ORDINARY_USER_AFTER_OFF_SENTINEL", { streamingBehavior: "followUp" });
		await Promise.all([pending, ordinary]);
		await session.waitForIdle();
		assert.equal(signal.aborted, true);
		assert.equal(ordinaryRequests.length, 1, "off must not sample the following ordinary user input");
		assert.ok(!JSON.stringify(ordinaryRequests[0].messages).includes("FIRST_TRACE_SENTINEL"));
		const ordinaryQuestion = ordinaryRequests[0].messages.at(-1);
		assert.ok(ordinaryQuestion);
		assert.ok(messageText(ordinaryQuestion).includes("ORDINARY_USER_AFTER_OFF_SENTINEL"));
		assert.ok(
			session.messages.some(
				(message) => message.role === "assistant" && messageText(message).includes("ORDINARY_AFTER_OFF_SENTINEL"),
			),
		);
		assert.deepEqual(extensionErrors, []);
	},
);

test("all three requests use the same @file snapshot even if the file changes during the first attempt", async (t) => {
	const { session, directory, faux, extensionErrors } = await createIntegrationSession(t);
	const fixture = join(directory, "fixture.txt");
	await writeFile(fixture, "ORIGINAL_FILE_CONTENT_SENTINEL: 42\n", "utf8");
	const requests: Context[] = [];
	faux.setResponses([
		async (context) => {
			requests.push(snapshotContext(context));
			await writeFile(fixture, "MODIFIED_FILE_CONTENT_SENTINEL: 99\n", "utf8");
			return firstAttempt(firstTrace);
		},
		(context) => {
			requests.push(snapshotContext(context));
			return firstAttempt(secondTrace);
		},
		(context) => {
			requests.push(snapshotContext(context));
			return fauxAssistantMessage("frozen file answer: 42");
		},
	]);
	await session.prompt("/tas on");
	await session.prompt("@fixture.txt QUESTION_AFTER_FILE_SENTINEL: what number does the file contain?");
	assert.equal(faux.state.callCount, 3);
	assert.equal(await readFile(fixture, "utf8"), "MODIFIED_FILE_CONTENT_SENTINEL: 99\n");
	assert.deepEqual(requests[0].messages, requests[1].messages);
	assert.deepEqual(requests[2].messages.slice(1), requests[0].messages);
	for (const context of requests) {
		const serialized = JSON.stringify(context.messages);
		assert.ok(serialized.includes("ORIGINAL_FILE_CONTENT_SENTINEL"));
		assert.ok(!serialized.includes("MODIFIED_FILE_CONTENT_SENTINEL"));
		assert.ok(
			serialized.indexOf("ORIGINAL_FILE_CONTENT_SENTINEL") < serialized.indexOf("QUESTION_AFTER_FILE_SENTINEL"),
		);
	}
	assert.ok(!JSON.stringify(session.messages).includes("ORIGINAL_FILE_CONTENT_SENTINEL"));
	assert.deepEqual(extensionErrors, []);
});

test("custom context appended after a native user message is included identically in both first attempts and the final request", async (t) => {
	const { session, faux, extensionErrors } = await createIntegrationSession(t, {
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => ({
					message: {
						customType: "tas-integration-context",
						content: "CUSTOM_AFTER_USER_SENTINEL: the source requires checking an extra condition.",
						display: false,
					},
				}));
			},
		],
	});
	const requests: Context[] = [];
	const responses = [firstAttempt(firstTrace), firstAttempt(secondTrace), fauxAssistantMessage("custom context final")];
	faux.setResponses(
		responses.map((response) => (context) => {
			requests.push(snapshotContext(context));
			return response;
		}),
	);
	await session.prompt("/tas on");
	await session.prompt(question);
	assert.equal(faux.state.callCount, 3);
	assert.equal(requests[0].messages.length, 2);
	assert.equal(messageText(requests[0].messages[0]), question);
	assert.ok(messageText(requests[0].messages[1]).includes("CUSTOM_AFTER_USER_SENTINEL"));
	assert.deepEqual(requests[1].messages, requests[0].messages);
	assert.deepEqual(requests[2].messages.slice(1), requests[0].messages);
	assert.deepEqual(extensionErrors, []);
});

test("automatic compaction after a completed final response keeps the TaS archive completed", async (t) => {
	const compactReasons: string[] = [];
	const { session, sessionManager, settingsManager, directory, faux, extensionErrors } = await createIntegrationSession(
		t,
		{
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						compactReasons.push(event.reason);
						return {
							compaction: {
								summary: "OFFLINE_COMPACTION_SUMMARY_SENTINEL",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		},
	);
	settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 1_000_000, keepRecentTokens: 0 } });
	faux.setResponses([
		firstAttempt(firstTrace),
		firstAttempt(secondTrace),
		fauxAssistantMessage("completed before compaction"),
	]);
	await session.prompt("/tas on");
	await session.prompt(question);
	assert.deepEqual(compactReasons, ["threshold"]);
	assert.equal(faux.state.callCount, 3);
	assert.ok(sessionManager.getBranch().some((entry) => entry.type === "compaction"));
	const runs = await readdir(join(directory, ".pi", "tas"));
	assert.equal(runs.length, 1);
	const archive: { status: string } = JSON.parse(
		await readFile(join(directory, ".pi", "tas", runs[0], "run.json"), "utf8"),
	);
	assert.equal(archive.status, "completed");
	assert.deepEqual(extensionErrors, []);
});

test(
	"cancelling the final request records a cancelled archive after both first attempts succeeded",
	{ timeout: 10_000 },
	async (t) => {
		const { session, directory, faux, extensionErrors } = await createIntegrationSession(t);
		const finalStarted = Promise.withResolvers<AbortSignal>();
		faux.setResponses([
			firstAttempt(firstTrace),
			firstAttempt(secondTrace),
			async (_context, options) => {
				assert.ok(options?.signal);
				const signal = options.signal;
				finalStarted.resolve(signal);
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return fauxAssistantMessage("cancelled final", { stopReason: "aborted" });
			},
		]);
		await session.prompt("/tas on");
		const pending = session.prompt(question);
		const signal = await finalStarted.promise;
		await session.abort();
		await pending;
		assert.equal(signal.aborted, true);
		assert.equal(faux.state.callCount, 3);
		const runs = await readdir(join(directory, ".pi", "tas"));
		assert.equal(runs.length, 1);
		const archive: { status: string; calls: Array<{ phase: string; stopReason: string }> } = JSON.parse(
			await readFile(join(directory, ".pi", "tas", runs[0], "run.json"), "utf8"),
		);
		assert.equal(archive.status, "cancelled");
		assert.deepEqual(
			archive.calls.map(({ phase, stopReason }) => ({ phase, stopReason })),
			[
				{ phase: "first-1", stopReason: "stop" },
				{ phase: "first-2", stopReason: "stop" },
				{ phase: "final", stopReason: "aborted" },
			],
		);
		assert.deepEqual(extensionErrors, []);
	},
);
