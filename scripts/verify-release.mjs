import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const name = `${manifest.name}-${manifest.version}`;
const staging = await mkdtemp(join(tmpdir(), "ds-maxpower-verify-"));
const hash = (data) => createHash("sha256").update(data).digest("hex");
const expectedFiles = [...manifest.files, "README.md", "package.json"].sort();

function run(command, args, env = process.env) {
	const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
	assert.equal(result.status, 0, `${command} failed`);
}

async function files(directory, prefix = directory) {
	const entries = [];
	for (const item of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, item.name);
		assert.ok(!item.isSymbolicLink(), "release contains a symbolic link");
		if (item.isDirectory()) entries.push(...(await files(path, prefix)));
		else entries.push(relative(prefix, path));
	}
	return entries.sort();
}

try {
	const checksums = (await readFile(join(root, "dist", "SHA256SUMS"), "utf8")).trim().split("\n");
	for (const line of checksums) {
		const [expected, file] = line.split("  ");
		assert.ok([`${name}.tgz`, `${name}.zip`].includes(file));
		assert.equal(hash(await readFile(join(root, "dist", file))), expected);
	}
	assert.equal(checksums.length, 2);
	run("tar", ["-xzf", join(root, "dist", `${name}.tgz`), "-C", staging]);
	await mkdir(join(staging, "zip"));
	run("unzip", ["-q", join(root, "dist", `${name}.zip`), "-d", join(staging, "zip")]);
	const packed = join(staging, "package");
	const zipped = join(staging, "zip", name);
	assert.deepEqual(await files(packed), expectedFiles);
	assert.deepEqual(await files(zipped), expectedFiles);
	for (const file of expectedFiles) {
		const sourceHash = hash(await readFile(join(root, file)));
		assert.equal(hash(await readFile(join(packed, file))), sourceHash, `tar differs: ${file}`);
		assert.equal(hash(await readFile(join(zipped, file))), sourceHash, `zip differs: ${file}`);
	}
	run(
		process.execPath,
		[
			"--import",
			join(root, "pi/node_modules/tsx/dist/loader.mjs"),
			"--test",
			join(root, "tas-extension/integration.test.ts"),
		],
		{ ...process.env, TSX_TSCONFIG_PATH: join(root, "pi/tsconfig.json"), TAS_PACKAGE_DIR: packed },
	);
	console.log(
		`Verified ${expectedFiles.length} release files, both SHA256 hashes, and the unpacked package's Pi manifest.`,
	);
} finally {
	await rm(staging, { recursive: true, force: true });
}
