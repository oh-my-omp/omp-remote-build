import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOAD = 64 * 1024 * 1024;
const args = process.argv.slice(2);
const row = args[0];
const srcIndex = args.indexOf("--src");
const src = srcIndex >= 0 ? args[srcIndex + 1] : undefined;
const baseline = args.includes("--baseline");
if ((row !== "row1" && row !== "row2" && row !== "row3") || src === undefined) {
	throw new Error("usage: transport.ts <row1|row2|row3> --src <plugin src dir> [--baseline]");
}

const stubDir = process.env.RB_ACCEPT18_DIR;
if (stubDir === undefined) {
	const fresh = await mkdtemp(join(tmpdir(), "rb-accept18-"));
	const bin = join(fresh, "bin");
	await Bun.write(join(bin, "ssh"), '#!/bin/sh\nshift\nexec sh -c "$*"\n');
	await Bun.write(join(bin, "mutagen"), `#!/bin/sh\n[ "$1 $2" = "sync flush" ] && exec head -c ${LOAD} /dev/zero\nexit 9\n`);
	await Bun.write(join(bin, "emit"), `#!/bin/sh\nexec head -c ${LOAD} /dev/zero\n`);
	for (const name of ["ssh", "mutagen", "emit"]) await chmod(join(bin, name), 0o755);
	const child = Bun.spawn([process.execPath, "--expose-gc", import.meta.path, ...args], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RB_ACCEPT18_DIR: fresh },
		stdio: ["ignore", "inherit", "inherit"],
	});
	process.exit(await child.exited);
}
const dir = stubDir;

const runModule = await import(join(src, "run.ts"));
const remoteFiles = await import(join(src, "remote-files.ts"));
const mutagen = await import(join(src, "mutagen.ts"));
const host = {
	ssh: "stub-host",
	remoteRoot: join(dir, "remote"),
	komodo: { endpoint: "p", server: "s", endpointsDir: join(dir, "endpoints") },
	bin: { km: "km", mutagen: "mutagen", baoExec: "bao-exec" },
};

async function measure<T>(call: () => Promise<T>): Promise<{ value: T; heapPeakDelta: number; rssPeakDelta: number }> {
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
	const value = await call();
	sample();
	clearInterval(timer);
	return { value, heapPeakDelta: heapPeak - before.heapUsed, rssPeakDelta: rssPeak - before.rss };
}

const describe = (value: unknown) => (typeof value === "string" ? `string(${value.length})` : String(value));

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

if (row === "row1") {
	const ignored = await measure(() => runModule.run(["emit"], { stdout: "ignore" }));
	const flushed = await measure(() => mutagen.flush(host, "stub-session"));
	console.log(
		JSON.stringify(
			{
				row,
				src,
				loadBytes: LOAD,
				ignoreCall: { returned: describe(ignored.value), heapPeakDelta: ignored.heapPeakDelta, rssPeakDelta: ignored.rssPeakDelta },
				mutagenFlush: { returned: describe(flushed.value), heapPeakDelta: flushed.heapPeakDelta, rssPeakDelta: flushed.rssPeakDelta },
			},
			null,
			2,
		),
	);
} else if (row === "row2") {
	const source = join(dir, "source.bin");
	await Bun.write(
		source,
		new Uint8Array(LOAD).map((_, i) => (i * 2654435761) >>> 24),
	);
	const target = join(host.remoteRoot, "nested", "target.bin");
	const written = await measure(async () =>
		remoteFiles.writeRemoteFile(host, target, baseline ? await Bun.file(source).bytes() : { kind: "file", path: source }),
	);
	const [sourceHash, targetHash] = await Promise.all([sha256(source), sha256(target)]);
	console.log(
		JSON.stringify(
			{
				row,
				src,
				mode: baseline ? "bytes (base signature)" : "file source",
				loadBytes: LOAD,
				returned: describe(written.value),
				heapPeakDelta: written.heapPeakDelta,
				rssPeakDelta: written.rssPeakDelta,
				targetBytes: Bun.file(target).size,
				sourceSha256: sourceHash,
				targetSha256: targetHash,
				identical: sourceHash === targetHash,
			},
			null,
			2,
		),
	);
} else {
	const node = (script: string) => [process.execPath, "-e", script];
	const outcome = async (call: () => Promise<unknown>) => {
		try {
			return { ok: await call() };
		} catch (error) {
			return error instanceof Error && "diagnostic" in error
				? { name: error.name, diagnostic: error.diagnostic, message: error.message }
				: { thrown: String(error) };
		}
	};
	const failing = node('process.stdout.write(" so "); process.stderr.write(" se "); process.exit(5)');
	console.log(
		JSON.stringify(
			{
				row,
				runSuccess: await outcome(() => runModule.run(node('process.stdout.write("out\\n")'))),
				runNonZeroStderr: await outcome(() => runModule.run(failing)),
				runNonZeroStdoutOnly: await outcome(() => runModule.run(node('process.stdout.write(" so "); process.exit(4)'))),
				runResultNonZero: await outcome(() => runModule.runResult(failing)),
				runResultSuccess: await outcome(() => runModule.runResult(node('process.stdout.write("a"); process.stderr.write("b")'))),
				writeRemoteFileString: await outcome(async () => {
					const target = join(host.remoteRoot, "s", "f.txt");
					await remoteFiles.writeRemoteFile(host, target, "héllo\n");
					return Bun.file(target).text();
				}),
				removeRemoteDir: await outcome(() => remoteFiles.removeRemoteDir(host, join(host.remoteRoot, "s"))),
				sshFailure: await outcome(() => remoteFiles.writeRemoteFile(host, "/dev/null/x/y", "z")),
			},
			null,
			2,
		),
	);
}
