import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type RunStatus = "sampling" | "final" | "completed" | "cancelled" | "failed" | "superseded";

/** The archive deliberately excludes model headers, auth, and provider error bodies. */
export class Archive {
	readonly id = randomUUID();
	readonly directory: string;
	readonly startedAt = new Date().toISOString();
	private calls: { phase: string; stopReason: string; usage: AssistantMessage["usage"]; elapsedMs: number | null }[] =
		[];
	private metadata: Record<string, unknown>;
	private ready: Promise<void>;
	private status: RunStatus = "sampling";
	private reason?: string;
	private writes = Promise.resolve();

	constructor(cwd: string, metadata: Record<string, unknown>) {
		this.directory = join(cwd, ".pi", "tas", this.id);
		this.metadata = metadata;
		this.ready = mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => {});
	}

	async start(input: unknown): Promise<void> {
		await this.write("input.json", input);
		await this.save("sampling");
	}

	async write(name: string, value: unknown): Promise<void> {
		const content = `${JSON.stringify(value, null, 2)}\n`;
		const operation = this.writes.then(async () => {
			await this.ready;
			const target = join(this.directory, name);
			const temporary = `${target}.${randomUUID()}.tmp`;
			await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
			await rename(temporary, target);
		});
		this.writes = operation.catch(() => {});
		await operation;
	}

	async record(phase: string, response: AssistantMessage, elapsedMs: number | null): Promise<void> {
		const { role, content, api, provider, model, usage, stopReason, timestamp, responseId } = response;
		this.calls.push({ phase, stopReason, usage, elapsedMs });
		await this.write(`${this.calls.length}-${phase}.json`, {
			role,
			content,
			api,
			provider,
			model,
			usage,
			stopReason,
			timestamp,
			responseId,
			elapsedMs,
		});
		await this.save(this.status, this.reason);
	}

	async save(status: RunStatus, reason?: string): Promise<void> {
		if (this.status === "sampling" || this.status === "final") {
			this.status = status;
			this.reason = reason;
		}
		await this.write("run.json", {
			...this.metadata,
			id: this.id,
			startedAt: this.startedAt,
			updatedAt: new Date().toISOString(),
			status: this.status,
			reason: this.reason,
			calls: this.calls,
			usage: this.calls.reduce(
				(sum, call) => ({
					input: sum.input + call.usage.input,
					output: sum.output + call.usage.output,
					cacheRead: sum.cacheRead + call.usage.cacheRead,
					cacheWrite: sum.cacheWrite + call.usage.cacheWrite,
				}),
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			),
			costNote: "Provider catalogue cost estimates are not a verified bill. Usage uses Pi's input/cache split.",
		});
	}
}
