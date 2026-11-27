import { afterEach, expect, test } from "bun:test";
import { type Diagnostic, humanErrorMessage, RemoteBuildError, renderDiagnostic } from "./diagnostics.ts";
import { run } from "./run.ts";

const originalLanguage = process.env.OMOMP_LANG;
afterEach(() => {
	if (originalLanguage === undefined) delete process.env.OMOMP_LANG;
	else process.env.OMOMP_LANG = originalLanguage;
});

test("notification rendering resolves language anew and preserves model-facing English", () => {
	const error = new RemoteBuildError({ kind: "host-read", path: "/tmp/missing.json", detail: "ENOENT: external diagnostic" });
	process.env.OMOMP_LANG = "zh";
	expect(humanErrorMessage(error)).toBe("无法读取主机配置 /tmp/missing.json：ENOENT: external diagnostic");
	expect(error.message).toBe("cannot read host config /tmp/missing.json: ENOENT: external diagnostic");
	process.env.OMOMP_LANG = "en";
	expect(humanErrorMessage(error)).toBe(error.message);
});

test("unknown external payloads remain data", () => {
	process.env.OMOMP_LANG = "zh";
	expect(humanErrorMessage(new Error("upstream English"))).toBe("upstream English");
	expect(humanErrorMessage("non-Error rejection")).toBe("non-Error rejection");
	const cause = new Error("external cause");
	expect(new RemoteBuildError({ kind: "ignore-read", path: "/tmp/.gitignore" }, { cause }).cause).toBe(cause);
});

test("every diagnostic branch renders in English and Chinese without losing context", () => {
	const diagnostics: Diagnostic[] = [
		{ kind: "host-read", path: "/tmp/host.json", detail: "external" },
		...(["object", "text", "unknown", "absolute", "host-absolute", "strings", "single-line"] as const).map(
			(reason) => ({ kind: "config-field", path: "/tmp/config", field: "field", reason }) satisfies Diagnostic,
		),
		{ kind: "config-relative", path: "/tmp/config", field: "include", value: "../bad" },
		{ kind: "config-image-source", path: "/tmp/config" },
		{ kind: "km-endpoint-read", path: "/tmp/endpoints/build.toml" },
		...(["host", "bao_path", "key_field", "secret_field"] as const).map(
			(field) =>
				({
					kind: "km-endpoint-field",
					endpoint: "build",
					path: "/tmp/endpoints/build.toml",
					field,
				}) satisfies Diagnostic,
		),
		{ kind: "km-endpoint-url", endpoint: "build", reason: "url" },
		{ kind: "km-endpoint-url", endpoint: "build", reason: "components" },
		{ kind: "bao-exec-spawn", command: "bao-exec", baoPath: "kv/example/ops" },
		{ kind: "bao-exec-exit", baoPath: "kv/example/ops", field: "komodo_api_key", code: 2 },
		{ kind: "bao-exec-value", baoPath: "kv/example/ops", field: "komodo_api_secret" },
		{ kind: "komodo-shape", field: "payload", expected: "object" },
		{ kind: "komodo-shape", field: "payload", expected: "string" },
		{ kind: "komodo-shape", field: "payload", expected: "boolean" },
		{ kind: "komodo-shape", field: "payload", expected: "number" },
		{ kind: "komodo-shape", field: "payload", expected: "array" },
		{ kind: "komodo-variant", variant: "image" },
		{ kind: "komodo-variant", variant: "update" },
		{ kind: "komodo-network", operation: "ListServers", host: "https://example.invalid" },
		{ kind: "komodo-http", operation: "ListServers", status: 401 },
		{ kind: "komodo-http", operation: "ListServers", status: 403 },
		{ kind: "komodo-http", operation: "ListServers", status: 500 },
		{ kind: "komodo-json", operation: "ListServers" },
		{ kind: "komodo-value", reason: "shell" },
		{ kind: "komodo-value", reason: "command" },
		{ kind: "komodo-value", reason: "name" },
		{ kind: "komodo-value", reason: "image" },
		{ kind: "komodo-value", reason: "workdir" },
		{ kind: "komodo-value", reason: "volume" },
		{ kind: "komodo-value", reason: "env" },
		{ kind: "deployment-timeout", deployment: "rb-test", update: "update-id" },
		{ kind: "deployment-failed", deployment: "rb-test", update: "update-id" },
		{ kind: "deployment-not-running", deployment: "rb-test", state: "created" },
		{ kind: "container-aborted", name: "rb-test" },
		{ kind: "container-disappeared", name: "rb-test" },
		{ kind: "container-timeout", name: "rb-test", minutes: 30 },
		{ kind: "command-exit", command: "ssh", code: 7, output: "external" },
		{ kind: "ignore-command", command: "config", code: 7, output: "external" },
		{ kind: "ignore-response", reason: "unterminated" },
		{ kind: "ignore-response", reason: "verbose" },
		{ kind: "ignore-read", path: "/tmp/.gitignore" },
		{ kind: "ignore-pattern", path: "/tmp/.gitignore", reason: "escape" },
		{ kind: "ignore-pattern", path: "/tmp/.gitignore", reason: "class" },
		{ kind: "ignore-pattern", path: "/tmp/.gitignore", reason: "unclosed" },
		{ kind: "mutagen-duplicate", label: "rb-env=test", ids: ["one", "two"] },
		{ kind: "mutagen-missing", id: "test" },
		{ kind: "move-timeout" },
	];
	for (const diagnostic of diagnostics) {
		const en = renderDiagnostic(diagnostic, "en");
		const zh = renderDiagnostic(diagnostic, "zh");
		expect(en).not.toMatch(/[\u4e00-\u9fff]/);
		expect(zh).toMatch(/[\u4e00-\u9fff]/);
		expect(new RemoteBuildError(diagnostic).message).toBe(en);
	}
});

test("actual command failures retain output and localize only notification prose", async () => {
	let caught: unknown;
	try {
		await run([process.execPath, "-e", 'process.stderr.write("external stderr"); process.exit(7)']);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(RemoteBuildError);
	process.env.OMOMP_LANG = "zh";
	expect(humanErrorMessage(caught)).toContain("以退出码 7 结束：external stderr");
	process.env.OMOMP_LANG = "en";
	expect(humanErrorMessage(caught)).toContain("exited 7: external stderr");
});
