import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = JSON.parse(readFileSync(new URL("./pi-source.json", import.meta.url), "utf8"));
const piRoot = join(root, "pi");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd = root) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error || result.status !== 0) throw new Error(`Setup failed: ${command} ${args.join(" ")}`);
}

if (!existsSync(piRoot)) {
	run("git", ["init", piRoot]);
	run("git", ["remote", "add", "origin", source.repository], piRoot);
	run("git", ["fetch", "--depth=1", "origin", source.revision], piRoot);
	run("git", ["checkout", "--detach", "FETCH_HEAD"], piRoot);
} else {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: piRoot, encoding: "utf8" });
	if (result.status !== 0 || result.stdout.trim() !== source.revision) {
		throw new Error(`Existing pi/ must be at ${source.revision}; setup will not change an existing checkout.`);
	}
}
run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], piRoot);
run(npm, ["run", "hydrate:model-data"], piRoot);
run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], join(root, "tas-lab"));
console.log(`Ready: Pi ${source.version} at ${source.revision}. Run npm run check and npm test.`);
