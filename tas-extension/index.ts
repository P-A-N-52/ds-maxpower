import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Archive, type RunStatus } from "./archive.ts";
import { assertBudget, fingerprint, freezeMessages, serializeTraces } from "./protocol.ts";

const SAMPLES = 2;
const OUTPUT_LIMIT = 32_768;
const SAMPLE_TIMEOUT_MS = 600_000;

interface Run {
	archive: Archive;
	controller: AbortController;
	task: string;
	sourceHash: string;
	modelHash: string;
	sourceLength: number;
	frozen: AgentMessage[];
	systemPrompt: string;
	trace?: UserMessage;
	status: RunStatus;
	lastStop?: AssistantMessage["stopReason"];
	requestStarted?: number;
	finished: boolean;
}

function requireModel(model: Model<string> | undefined): Model<"openai-completions"> {
	if (
		!model ||
		model.provider !== "deepseek" ||
		model.api !== "openai-completions" ||
		!model.id.startsWith("deepseek-v4-") ||
		!model.reasoning
	) {
		throw new Error("TaS 首版需要 DeepSeek V4 thinking 模型（deepseek / openai-completions）。");
	}
	if (model.maxTokens < OUTPUT_LIMIT) {
		throw new Error("TaS 需要模型支持至少 32,768 输出 token。");
	}
	return model as Model<"openai-completions">;
}

function settledStatus(run: Run): RunStatus {
	if (run.controller.signal.aborted || run.lastStop === "aborted") return "cancelled";
	return run.lastStop === "stop" ? "completed" : "failed";
}

export default function tas(pi: ExtensionAPI): void {
	let enabled = false;
	let active: Run | undefined;

	const showStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("tas", enabled ? `TaS on · ${active?.status ?? "ready"} · N=${SAMPLES}` : undefined);
	};

	async function finish(run: Run, status: RunStatus, reason?: string): Promise<void> {
		if (run.finished) return;
		run.finished = true;
		run.status = status;
		await run.archive.save(status, reason);
	}

	async function stop(ctx: ExtensionContext, reason: string): Promise<void> {
		const run = active;
		active = undefined;
		if (!run) return;
		run.controller.abort();
		ctx.abort();
		await finish(run, "cancelled", reason);
	}

	pi.registerCommand("tas", {
		description: "TaS 模式：/tas on | off | status（默认关闭，当前会话有效）",
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			if (command === "on") {
				try {
					requireModel(ctx.model);
				} catch (error) {
					ctx.ui.notify((error as Error).message, "error");
					return;
				}
				if (!enabled && !ctx.isIdle()) {
					ctx.ui.notify("请等当前任务结束后再开启 TaS。", "warning");
					return;
				}
				enabled = true;
				ctx.ui.notify("TaS 已开启：每个新任务先独立推理 2 次，再进入正常工具循环。Esc 取消；/tas off 退出。", "info");
			} else if (command === "off") {
				enabled = false;
				await stop(ctx, "Mode switched off");
				ctx.ui.notify("TaS 已关闭。", "info");
			} else if (command === "status") {
				ctx.ui.notify(
					`TaS ${enabled ? "开启" : "关闭"}；${active?.status ?? "空闲"}；N=2；每次输出 ≤32,768 token；每条轨迹 ≤50,000 字符。`,
					"info",
				);
			} else {
				ctx.ui.notify("用法：/tas on | /tas off | /tas status", "warning");
			}
			showStatus(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		active = undefined;
		showStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		enabled = false;
		await stop(ctx, "Session closed or replaced");
	});

	pi.on("model_select", async (_event, ctx) => {
		if (active) await stop(ctx, "Model changed");
		if (enabled) {
			try {
				requireModel(ctx.model);
			} catch {
				enabled = false;
				ctx.ui.notify("当前模型不支持 TaS，模式已关闭。", "warning");
			}
		}
		showStatus(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const run = active;
		if (!run) return;
		if (!ctx.signal && !event.willRetry) {
			active = undefined;
			await finish(run, settledStatus(run));
			return;
		}
		// An in-flight task must never reuse traces against summarized/replaced input.
		await stop(ctx, "Compaction would replace the frozen input");
		ctx.ui.notify("TaS 已停止本次任务：上下文需要压缩。请压缩后重新提交任务。", "warning");
		return { cancel: true };
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		const userIndex = event.messages.findLastIndex((message) => message.role === "user");
		if (userIndex < 0) return;
		const task = fingerprint({ userIndex, message: event.messages[userIndex] });
		const nativeSignal = ctx.signal;
		let run = active;

		try {
			const model = requireModel(ctx.model);
			if (!nativeSignal) throw new Error("TaS 需要 Pi agent 的取消信号。");
			nativeSignal.throwIfAborted();
			if (!run || run.task !== task) {
				if (run) {
					run.controller.abort();
					await finish(run, run.lastStop === "stop" ? "completed" : "superseded", "New user task");
				}
				// Include custom context appended after the native user by other extensions.
				const original = event.messages;
				const systemPrompt = ctx.getSystemPrompt();
				const sourceHash = fingerprint(original);
				run = {
					archive: new Archive(ctx.cwd, {
						sessionId: ctx.sessionManager.getSessionId(),
						model: model.id,
						provider: model.provider,
						api: model.api,
						sourceHash,
						samples: SAMPLES,
						reasoningEffort: "max",
						outputLimit: OUTPUT_LIMIT,
						traceLimit: 50_000,
						traceUnit: "Unicode characters",
					}),
					controller: new AbortController(),
					task,
					sourceHash,
					modelHash: fingerprint(model),
					sourceLength: original.length,
					frozen: [],
					systemPrompt,
					status: "sampling",
					finished: false,
				};
				active = run;
				showStatus(ctx);
				await run.archive.start({ systemPrompt, messages: original, frozen: false });
				if (active !== run) return;
				const frozen = await freezeMessages(original, ctx.cwd);
				if (active !== run) return;
				nativeSignal.throwIfAborted();
				run.frozen = frozen.messages;
				assertBudget(systemPrompt, run.frozen, [], model.contextWindow, OUTPUT_LIMIT);
				await run.archive.write("input.json", {
					systemPrompt,
					messages: run.frozen,
					files: frozen.files,
					frozen: true,
				});
				const responses: AssistantMessage[] = [];

				for (let i = 0; i < SAMPLES; i++) {
					if (active !== run) return;
					const signal = AbortSignal.any([nativeSignal, run.controller.signal, AbortSignal.timeout(SAMPLE_TIMEOUT_MS)]);
					signal.throwIfAborted();
					ctx.ui.setStatus("tas", `TaS · 独立推理 ${i + 1}/${SAMPLES} · Esc 取消`);
					const started = performance.now();
					const response = await ctx.modelRegistry
						.complete(
							model,
							{
								systemPrompt,
								messages: convertToLlm(structuredClone(run.frozen)),
							},
							{ reasoningEffort: "max", maxTokens: OUTPUT_LIMIT, maxRetries: 0, signal },
						)
						.catch(() => {
							// Auth/network errors can contain request details. Never persist them.
							throw new Error("TaS 首遍请求失败，请检查模型认证或网络。");
						});
					await run.archive.record(`first-${i + 1}`, response, Math.round(performance.now() - started));
					if (active !== run) return;
					signal.throwIfAborted();
					serializeTraces([response]); // Reject errors, truncation, or absent reasoning immediately.
					responses.push(response);
				}
				run.trace = { role: "user", content: serializeTraces(responses), timestamp: Date.now() };
				await run.archive.write("trace.json", run.trace);
				if (active !== run) return;
				run.status = "final";
				await run.archive.save("final");
			}

			if (active !== run) return;
			nativeSignal.throwIfAborted();
			run.controller.signal.throwIfAborted();
			if (
				fingerprint(event.messages.slice(0, run.sourceLength)) !== run.sourceHash ||
				fingerprint(model) !== run.modelHash ||
				ctx.getSystemPrompt() !== run.systemPrompt
			) {
				throw new Error("TaS 的冻结输入、模型或系统提示发生变化，本次任务已停止。");
			}
			if (!run.trace) throw new Error("TaS 未完成独立推理。");
			const messages = [run.trace, ...run.frozen, ...event.messages.slice(run.sourceLength)];
			const tools = pi.getAllTools().filter((tool) => pi.getActiveTools().includes(tool.name));
			assertBudget(run.systemPrompt, messages, tools, model.contextWindow, OUTPUT_LIMIT);
			run.requestStarted = performance.now();
			showStatus(ctx);
			return { messages };
		} catch (error) {
			// Pi catches extension exceptions and otherwise continues with the original prompt.
			// Explicitly abort the native request; never silently fall back after paid prepasses.
			if (run && active !== run) return;
			const cancelled = nativeSignal?.aborted || run?.controller.signal.aborted;
			const reason = cancelled ? "TaS 已取消。" : error instanceof Error ? error.message : "TaS 失败。";
			ctx.abort();
			if (run) {
				run.controller.abort();
				await finish(run, cancelled ? "cancelled" : "failed", reason);
			}
			ctx.ui.notify(reason, cancelled ? "info" : "error");
			return { messages: [] };
		}
	});

	pi.on("before_provider_request", (event) => {
		if (!active || active.status !== "final" || active.controller.signal.aborted) return;
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
		return { ...event.payload, thinking: { type: "enabled" }, reasoning_effort: "max", max_tokens: OUTPUT_LIMIT };
	});

	pi.on("message_end", async (event) => {
		const run = active;
		if (!run || run.finished || event.message.role !== "assistant") return;
		run.lastStop = event.message.stopReason;
		await run.archive.record(
			"final",
			event.message,
			run.requestStarted === undefined ? null : Math.round(performance.now() - run.requestStarted),
		);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const run = active;
		active = undefined;
		if (run) {
			await finish(run, settledStatus(run));
		}
		showStatus(ctx);
	});
}
