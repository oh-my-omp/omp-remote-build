import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { type Diagnostic, RemoteBuildError } from "./diagnostics.ts";
import type { HostConfig } from "./types.ts";

/** User-level host config: `<omp agent dir>/remote-build.json` (`~/.omp/agent` by default). */
export function hostConfigPath(): string {
	return join(getAgentDir(), "remote-build.json");
}

const KNOWN_FIELDS: Record<keyof HostConfig, true> = { ssh: true, remoteRoot: true, komodo: true, bin: true };
const KNOWN_KOMODO_FIELDS: Record<keyof HostConfig["komodo"], true> = { profile: true, server: true, cliConfig: true };
const KNOWN_BIN_FIELDS: Record<keyof HostConfig["bin"], true> = { km: true, mutagen: true };

/**
 * Reads the host config anew on every call, so edits apply without restarting omp.
 * Throws when the file is missing or invalid.
 */
export async function loadHost(): Promise<HostConfig> {
	const path = hostConfigPath();
	let raw: unknown;
	try {
		raw = JSON.parse(await Bun.file(path).text());
	} catch (error) {
		throw new RemoteBuildError(
			{ kind: "host-read", path, detail: error instanceof Error ? error.message : String(error) },
			{ cause: error },
		);
	}
	const fail = (field: string, reason: Extract<Diagnostic, { kind: "config-field" }>["reason"]): never => {
		throw new RemoteBuildError({ kind: "config-field", path, field, reason });
	};
	const object = (value: unknown, field: string, known: Record<string, true>): Record<string, unknown> => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(field, "object");
		for (const key of Object.keys(value)) {
			if (!(key in known)) fail(field === "config" ? key : `${field}.${key}`, "unknown");
		}
		return value as Record<string, unknown>;
	};
	const text = (value: unknown, field: string): string => (typeof value === "string" && value.trim() !== "" ? value : fail(field, "text"));

	const config = object(raw, "config", KNOWN_FIELDS);
	const komodo = object(config.komodo, "komodo", KNOWN_KOMODO_FIELDS);
	const bin = object(config.bin ?? {}, "bin", KNOWN_BIN_FIELDS);
	const remoteRoot = text(config.remoteRoot, "remoteRoot").replace(/\/+$/, "");
	if (!remoteRoot.startsWith("/")) fail("remoteRoot", "host-absolute");
	const cliConfig = text(komodo.cliConfig ?? join(homedir(), ".config", "komodo", "komodo.cli.toml"), "komodo.cliConfig");
	return {
		ssh: text(config.ssh, "ssh"),
		remoteRoot,
		komodo: {
			profile: text(komodo.profile, "komodo.profile"),
			server: text(komodo.server, "komodo.server"),
			cliConfig: cliConfig.startsWith("~/") ? join(homedir(), cliConfig.slice(2)) : cliConfig,
		},
		bin: {
			km: text(bin.km ?? "km", "bin.km"),
			mutagen: text(bin.mutagen ?? "mutagen", "bin.mutagen"),
		},
	};
}
