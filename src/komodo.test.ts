import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBuildError } from "./diagnostics.ts";
import { execTransport, komodoReachable } from "./komodo.ts";
import type { HostConfig } from "./types.ts";

const BAO_PATH = "kv/test/creds";
const ENDPOINT = "core-probe";
const SCRIPT_PROLOGUE = `#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\n`;

const previousLang = process.env.OMOMP_LANG;
const tempDirs: string[] = [];

beforeAll(() => {
	process.env.OMOMP_LANG = "en";
});

afterAll(() => {
	if (previousLang === undefined) delete process.env.OMOMP_LANG;
	else process.env.OMOMP_LANG = previousLang;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
	readonly dir: string;
	readonly host: HostConfig;
	readonly endpointPath: string;
	writeEndpoint(text: string): void;
	writeScript(body: string): void;
	writeValue(field: "key" | "secret", value: string): void;
}

let fixtureCount = 0;

function fixture(origin: string): Fixture {
	const dir = mkdtempSync(join(tmpdir(), `rb-komodo-${fixtureCount++}-`));
	tempDirs.push(dir);
	const endpointsDir = join(dir, "endpoints");
	mkdirSync(endpointsDir, { recursive: true });
	const endpointPath = join(endpointsDir, `${ENDPOINT}.toml`);
	const baoExec = join(dir, "bao-exec");
	const keyFile = join(dir, "key");
	const secretFile = join(dir, "secret");
	writeFileSync(keyFile, "K-test\n");
	writeFileSync(secretFile, "S-test\n");
	const writeScript = (body: string): void => {
		writeFileSync(baoExec, body);
		chmodSync(baoExec, 0o755);
	};
	const writeEndpoint = (text: string): void => writeFileSync(endpointPath, text);
	writeScript(`${SCRIPT_PROLOGUE}STUB_KEY="$(cat '${keyFile}')" STUB_SECRET="$(cat '${secretFile}')" "$@"\n`);
	writeEndpoint(`host = "${origin}"\nbao_path = "${BAO_PATH}"\nkey_field = "STUB_KEY"\nsecret_field = "STUB_SECRET"\n`);
	return {
		dir,
		host: {
			ssh: "stub-host",
			remoteRoot: "/srv/remote-build",
			komodo: { endpoint: ENDPOINT, server: "stub-server", endpointsDir },
			bin: { km: "km", mutagen: "mutagen", baoExec },
		},
		endpointPath,
		writeEndpoint,
		writeScript,
		writeValue: (field, value) => writeFileSync(field === "key" ? keyFile : secretFile, `${value}\n`),
	};
}

interface SeenRequest {
	readonly method: string;
	readonly path: string;
	readonly key: string | null;
	readonly secret: string | null;
	readonly type: unknown;
	readonly params: unknown;
}

function serve(): { readonly url: string; readonly seen: SeenRequest[]; stop(): void } {
	const seen: SeenRequest[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { type?: unknown; params?: unknown };
			seen.push({
				method: request.method,
				path: new URL(request.url).pathname,
				key: request.headers.get("x-api-key"),
				secret: request.headers.get("x-api-secret"),
				type: body.type,
				params: body.params,
			});
			return Response.json([]);
		},
	});
	return {
		url: server.url.origin,
		seen,
		stop: () => {
			server.stop(true);
		},
	};
}

async function rejection(call: Promise<unknown>): Promise<RemoteBuildError> {
	try {
		await call;
	} catch (error) {
		expect(error).toBeInstanceOf(RemoteBuildError);
		return error as RemoteBuildError;
	}
	throw new Error("expected the call to reject");
}

function expectNoSecretValues(error: RemoteBuildError): void {
	const rendered = `${error.message}\n${JSON.stringify(error.diagnostic)}`;
	expect(rendered).not.toContain("K-test");
	expect(rendered).not.toContain("S-test");
}

test("komodoReachable authenticates with OpenBao values and execTransport builds the km argv", async () => {
	const stub = serve();
	const f = fixture(stub.url);
	try {
		await komodoReachable(f.host);

		expect(stub.seen).toHaveLength(1);
		const seen = stub.seen[0]!;
		expect(seen.method).toBe("POST");
		expect(seen.path).toBe("/read");
		expect(seen.type).toBe("ListServers");
		expect(seen.params).toEqual({});
		expect(seen.key).toBe("K-test");
		expect(seen.secret).toBe("S-test");

		const transport = await execTransport(f.host, "rb-test", "bash");
		expect(transport.argv).toEqual(["km", "exec", "--server", "stub-server", "rb-test", "bash"]);
		expect(transport.argv).not.toContain("-c");
		expect(transport.argv).not.toContain("-p");
		expect(transport.env).toEqual({
			KOMODO_CLI_HOST: stub.url,
			KOMODO_CLI_KEY: "K-test",
			KOMODO_CLI_SECRET: "S-test",
		});
		expect(stub.seen).toHaveLength(1);
	} finally {
		stub.stop();
	}
});

test("every Komodo operation reloads the OpenBao fields", async () => {
	const stub = serve();
	const f = fixture(stub.url);
	try {
		await komodoReachable(f.host);
		f.writeValue("key", "K-rotated");
		f.writeValue("secret", "S-rotated");

		const transport = await execTransport(f.host, "rb-test", "bash");
		expect(transport.env).toEqual({
			KOMODO_CLI_HOST: stub.url,
			KOMODO_CLI_KEY: "K-rotated",
			KOMODO_CLI_SECRET: "S-rotated",
		});

		await komodoReachable(f.host);
		expect(stub.seen.map((entry) => [entry.key, entry.secret])).toEqual([
			["K-test", "S-test"],
			["K-rotated", "S-rotated"],
		]);
	} finally {
		stub.stop();
	}
});

test("missing endpoint file reports km-endpoint-read with its path", async () => {
	const f = fixture("http://127.0.0.1:1");
	rmSync(f.endpointPath);

	const error = await rejection(komodoReachable(f.host));
	expect(error.diagnostic).toEqual({ kind: "km-endpoint-read", path: f.endpointPath });
	expect(error.message).toContain(f.endpointPath);
	expectNoSecretValues(error);
});

test("endpoint file that is not TOML reports km-endpoint-read without the parse text", async () => {
	const f = fixture("http://127.0.0.1:1");
	f.writeEndpoint('host = "http://127.0.0.1:1\nbao_path = "kv/test/creds"\n');

	const error = await rejection(komodoReachable(f.host));
	expect(error.diagnostic).toEqual({ kind: "km-endpoint-read", path: f.endpointPath });
	expect(error.message).toContain(f.endpointPath);
	expectNoSecretValues(error);
});

test("missing bao_path reports km-endpoint-field for the endpoint", async () => {
	const f = fixture("http://127.0.0.1:1");
	f.writeEndpoint(`host = "http://127.0.0.1:1"\nkey_field = "STUB_KEY"\nsecret_field = "STUB_SECRET"\n`);

	const error = await rejection(komodoReachable(f.host));
	expect(error.diagnostic).toEqual({ kind: "km-endpoint-field", endpoint: ENDPOINT, path: f.endpointPath, field: "bao_path" });
	expect(error.message).toContain(ENDPOINT);
	expect(error.message).toContain("bao_path");
	expectNoSecretValues(error);
});

test("invalid key_field reports km-endpoint-field for the endpoint", async () => {
	const f = fixture("http://127.0.0.1:1");
	f.writeEndpoint(`host = "http://127.0.0.1:1"\nbao_path = "${BAO_PATH}"\nkey_field = "bad-name"\nsecret_field = "STUB_SECRET"\n`);

	const error = await rejection(komodoReachable(f.host));
	expect(error.diagnostic).toEqual({ kind: "km-endpoint-field", endpoint: ENDPOINT, path: f.endpointPath, field: "key_field" });
	expect(error.message).toContain(ENDPOINT);
	expect(error.message).toContain("key_field");
	expectNoSecretValues(error);
});

test("non-HTTP host reports km-endpoint-url", async () => {
	const f = fixture("http://127.0.0.1:1");
	f.writeEndpoint(`host = "ftp://x"\nbao_path = "${BAO_PATH}"\nkey_field = "STUB_KEY"\nsecret_field = "STUB_SECRET"\n`);

	const error = await rejection(komodoReachable(f.host));
	expect(error.diagnostic).toEqual({ kind: "km-endpoint-url", endpoint: ENDPOINT, reason: "url" });
	expect(error.message).toContain(ENDPOINT);
	expectNoSecretValues(error);
});

test("host with embedded credentials reports km-endpoint-url components", async () => {
	const f = fixture("http://127.0.0.1:1");
	f.writeEndpoint(`host = "http://u:p@h"\nbao_path = "${BAO_PATH}"\nkey_field = "STUB_KEY"\nsecret_field = "STUB_SECRET"\n`);

	const error = await rejection(komodoReachable(f.host));
	expect(error.diagnostic).toEqual({ kind: "km-endpoint-url", endpoint: ENDPOINT, reason: "components" });
	expect(error.message).toContain(ENDPOINT);
	expectNoSecretValues(error);
});

test("failing bao-exec reports bao-exec-exit with the code", async () => {
	const f = fixture("http://127.0.0.1:1");
	f.writeScript(`${SCRIPT_PROLOGUE}echo K-test\necho K-test >&2\nexit 3\n`);

	const error = await rejection(komodoReachable(f.host));
	expect(error.diagnostic.kind).toBe("bao-exec-exit");
	if (error.diagnostic.kind !== "bao-exec-exit") throw new Error("expected bao-exec-exit");
	expect(error.diagnostic.baoPath).toBe(BAO_PATH);
	expect(error.diagnostic.code).toBe(3);
	expect(["STUB_KEY", "STUB_SECRET"]).toContain(error.diagnostic.field);
	expect(error.message).toContain(BAO_PATH);
	expect(error.message).toContain("3");
	expectNoSecretValues(error);
});

test("empty bao-exec value reports bao-exec-value", async () => {
	const f = fixture("http://127.0.0.1:1");
	f.writeScript(`${SCRIPT_PROLOGUE}if [ "$2" = "STUB_KEY" ]; then printf '\\n'; else printf 'S-test\\n'; fi\n`);

	const error = await rejection(komodoReachable(f.host));
	expect(error.diagnostic).toEqual({ kind: "bao-exec-value", baoPath: BAO_PATH, field: "STUB_KEY" });
	expect(error.message).toContain(BAO_PATH);
	expectNoSecretValues(error);
});

test("missing bao-exec binary reports bao-exec-spawn", async () => {
	const f = fixture("http://127.0.0.1:1");
	const missing = join(f.dir, "missing-bao-exec");
	const host: HostConfig = { ...f.host, bin: { ...f.host.bin, baoExec: missing } };

	const error = await rejection(komodoReachable(host));
	expect(error.diagnostic.kind).toBe("bao-exec-spawn");
	if (error.diagnostic.kind !== "bao-exec-spawn") throw new Error("expected bao-exec-spawn");
	expect(error.diagnostic.baoPath).toBe(BAO_PATH);
	expect(error.diagnostic.command).toContain(missing);
	expect(error.message).toContain(BAO_PATH);
	expectNoSecretValues(error);
});
