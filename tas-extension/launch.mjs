import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKimiDeepSeek } from "./kimi-config.mjs";

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(extensionRoot);
const piRoot = join(projectRoot, "pi");
const profileDir = join(projectRoot, ".tas-pi");

export async function assertNoStoredDeepSeekCredential(directory) {
	let auth;
	try {
		const content = await readFile(join(directory, "auth.json"), "utf8");
		auth = JSON.parse(content.replace(/^\uFEFF/, ""));
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw new Error("Unable to read or parse the dedicated Pi profile auth.json");
	}
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
		throw new Error("Invalid dedicated Pi profile auth.json");
	}
	if (Object.hasOwn(auth, "deepseek")) {
		throw new Error(
			"The dedicated .tas-pi profile already contains a DeepSeek credential; refusing to override Kimi authentication",
		);
	}
}

export async function launch(args = process.argv.slice(2)) {
	await assertNoStoredDeepSeekCredential(profileDir);
	const { apiKey } = await loadKimiDeepSeek();
	const require = createRequire(join(piRoot, "package.json"));
	const child = spawn(
		process.execPath,
		[
			"--import",
			require.resolve("tsx"),
			join(piRoot, "packages/coding-agent/src/cli.ts"),
			"--extension",
			join(extensionRoot, "index.ts"),
			"--provider",
			"deepseek",
			"--model",
			"deepseek-v4-pro",
			"--thinking",
			"max",
			...args,
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				DEEPSEEK_API_KEY: apiKey,
				PI_CODING_AGENT_DIR: profileDir,
				TSX_TSCONFIG_PATH: join(piRoot, "tsconfig.json"),
			},
			stdio: "inherit",
		},
	);
	const interrupt = () => child.kill("SIGINT");
	const terminate = () => child.kill("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	try {
		return await new Promise((resolveExit, reject) => {
			child.once("error", (error) => reject(new Error(`Unable to start Pi (${error.code ?? "spawn failed"})`)));
			child.once("exit", (code, signal) => resolveExit(code ?? 128 + (constants.signals[signal] ?? 1)));
		});
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		process.exitCode = await launch();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
