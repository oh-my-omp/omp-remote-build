/**
 * #20 acceptance driver: `prepareEnv` (src/environment.ts) transferring containerFiles under a 64 MiB load.
 *
 * Usage: bun --expose-gc accept/container-files.ts <row1|row2> --src <plugin src dir>
 *   --src  the checkout under test (head or base), so one driver measures both
 *   row1   containerFiles = a 64 MiB file and a small one; peak heap/RSS of prepareEnv, remote bytes compared
 *   row2   containerFiles = small, missing, small; prepareEnv must reject before the missing file's ssh
 *
 * Nothing outside a fresh temp dir is touched: the omp agent dir (host config) is
 * PI_CODING_AGENT_DIR=<tmp>/agent; stubs first on PATH log every argv to <tmp>/calls.log:
 * `ssh [-o …] <host> <cmd>` runs <cmd> under `sh -c` locally, `mutagen sync list/create/flush`
 * keeps one session id in <tmp>/session; a local HTTP Komodo Core stub answers ListServers.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOAD = 64 * 1024 * 1024;
const args = process.argv.slice(2);
const row = args[0];
const srcIndex = args.indexOf("--src");
const src = srcIndex >= 0 ? args[srcIndex + 1] : undefined;
if ((row !== "row1" && row !== "row2") || src === undefined) throw new Error("usage: container-files.ts <row1|row2> --src <plugin src dir>");

// The agent dir and executable lookup are fixed at process start, so the driver
// prepares the sandbox, then re-runs itself with PATH and PI_CODING_AGENT_DIR set.
const sandbox = process.env.RB_ACCEPT20_DIR;
if (sandbox === undefined) {
	const dir = await mkdtemp(join(tmpdir(), "rb-accept20-"));
	const bin = join(dir, "bin");
	const log = join(dir, "calls.log");
	await Bun.write(join(bin, "ssh"), `#!/bin/sh
echo "ssh $*" >> '${log}'
while [ "$1" = "-o" ]; do shift 2; done
shift
exec sh -c "$*"
`);
	await Bun.write(join(bin, "mutagen"), `#!/bin/sh
echo "mutagen $*" >> '${log}'
case "$1 $2" in
  "sync list") [ -f '${dir}/session' ] && cat '${dir}/session'; exit 0 ;;
  "sync create") echo sync_stub_session > '${dir}/session'; exit 0 ;;
  "sync flush") exit 0 ;;
esac
exit 9
`);
	for (const name of ["ssh", "mutagen"]) await chmod(join(bin, name), 0o755);
	const child = Bun.spawn([process.execPath, "--expose-gc", import.meta.path, ...args], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: join(dir, "agent"), RB_ACCEPT20_DIR: dir },
		stdio: ["ignore", "inherit", "inherit"],
	});
	process.exit(await child.exited);
}
const dir = sandbox;

const core = Bun.serve({
	port: 0,
	fetch: async request => {
		const body: unknown = await request.json();
		const type = typeof body === "object" && body !== null && "type" in body ? body.type : undefined;
		return type === "ListServers" ? Response.json([]) : new Response("unexpected", { status: 400 });
	},
});
await writeFile(join(dir, "km.toml"), `[[profile]]\nname = "stub"\nhost = "http://127.0.0.1:${core.port}"\nkey = "k"\nsecret = "s"\n`);
await mkdir(join(dir, "agent"), { recursive: true });
await writeFile(join(dir, "agent", "remote-build.json"), JSON.stringify({
	ssh: "stub-host",
	remoteRoot: join(dir, "remote"),
	komodo: { profile: "stub", server: "stub-server", cliConfig: join(dir, "km.toml") },
}));

const root = join(dir, "repo");
await mkdir(join(root, ".omp"), { recursive: true });
await mkdir(join(root, "data"), { recursive: true });
await writeFile(join(root, ".gitignore"), "data/\n");
await writeFile(join(root, "README"), "load repo\n");
await writeFile(join(root, "data", "small.txt"), "small container file\n");
const containerFiles = row === "row1"
	? { "secrets/big.bin": "data/big.bin", "conf/small.txt": "data/small.txt" }
	: { "conf/a.txt": "data/small.txt", "secrets/missing.bin": "data/missing.bin", "conf/c.txt": "data/small.txt" };
if (row === "row1") await Bun.write(join(root, "data", "big.bin"), new Uint8Array(LOAD).map((_, i) => (i * 2654435761) >>> 24));
await writeFile(join(root, ".omp", "remote-build.json"), JSON.stringify({ containerFiles }));
for (const argv of [["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "load"]]) {
	if ((await Bun.spawn(["git", "-C", root, ...argv], { stdout: "ignore" }).exited) !== 0) throw new Error(`git ${argv.join(" ")} failed`);
}

// Runtime-selected checkout (--src): the same driver measures the base and the head.
const environment = await import(join(src, "environment.ts"));
const configModule = await import(join(src, "config.ts"));
const config = await configModule.loadConfig(root);

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

const sshWrites = async () =>
	(await readFile(join(dir, "calls.log"), "utf8")).split("\n").filter(line => line.startsWith("ssh stub-host mkdir")).map(line => line.replaceAll(join(dir, "remote"), "<remote>"));

if (row === "row1") {
	Bun.gc(true);
	const before = process.memoryUsage();
	let heapPeak = before.heapUsed;
	let rssPeak = before.rss;
	const sample = () => {
		const now = process.memoryUsage();
		heapPeak = Math.max(heapPeak, now.heapUsed);
		rssPeak = Math.max(rssPeak, now.rss);
	};
	const timer = setInterval(sample, 2);
	const env = await environment.prepareEnv(root, config);
	sample();
	clearInterval(timer);
	const files = [];
	for (const [target, source] of Object.entries(containerFiles)) {
		const local = join(root, source);
		const remote = join(env.remotePath, target);
		const [localSha, remoteSha] = await Promise.all([sha256(local), sha256(remote)]);
		files.push({ target, bytes: Bun.file(remote).size, localSha256: localSha, remoteSha256: remoteSha, identical: localSha === remoteSha });
	}
	console.log(JSON.stringify({ row, src, loadBytes: LOAD, heapPeakDelta: heapPeak - before.heapUsed, rssPeakDelta: rssPeak - before.rss, files, sshWrites: await sshWrites() }, null, 2));
} else {
	let outcome: unknown;
	try {
		await environment.prepareEnv(root, config);
		outcome = { resolved: true };
	} catch (error) {
		outcome = { rejected: true, code: error instanceof Error && "code" in error ? error.code : undefined, message: error instanceof Error ? error.message.replaceAll(dir, "<tmp>") : String(error) };
	}
	const remote = join(dir, "remote");
	console.log(JSON.stringify({
		row, src, outcome,
		sshWrites: await sshWrites(),
		missingTargetCreated: [...new Bun.Glob("*/secrets/missing.bin").scanSync(remote)].length > 0,
		laterTargetWritten: [...new Bun.Glob("*/conf/c.txt").scanSync(remote)].length > 0,
		missingSourceCreated: existsSync(join(root, "data", "missing.bin")),
	}, null, 2));
}
core.stop(true);
