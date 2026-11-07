/**
 * Translate Git's active ignore sources, rather than snapshotting ignored files:
 * the resulting rules also cover build directories/files created later. Git is
 * the oracle for source discovery and for reopening ignored ancestors of tracked
 * files and explicit includes; guards keep their otherwise ignored siblings out.
 * Extra Mutagen ignores and container targets intentionally win over includes.
 * Rules describe the index and ignore files at derivation time: changing either
 * (including adding a nested .gitignore) requires rederivation/session recreation.
 * Git's byte-oriented ?/classes and doublestar's Unicode matching differ for
 * non-ASCII names; portable ASCII glob operands have equivalent semantics.
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MutagenIgnoreRules, RemoteBuildConfig } from "./types.js";
import { RemoteBuildError } from "./diagnostics.ts";

type GitResult = { readonly text: string; readonly code: number };

async function git(root: string, args: readonly string[], input?: string): Promise<GitResult> {
	const child = Bun.spawn(["git", "-C", root, ...args], {
		stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [text, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0 && !(code === 1 && (args[0] === "config" || args[0] === "check-ignore"))) {
		throw new RemoteBuildError({ kind: "ignore-command", command: args[0]!, code, output: stderr.trim() });
	}
	return { text, code };
}

function nulFields(text: string): string[] {
	if (text === "") return [];
	if (!text.endsWith("\0")) throw new RemoteBuildError({ kind: "ignore-response", reason: "unterminated" });
	return text.slice(0, -1).split("\0");
}

async function ignoredPaths(root: string, paths: readonly string[]): Promise<Set<string>> {
	if (paths.length === 0) return new Set();
	const { text } = await git(root, ["check-ignore", "--no-index", "-z", "--stdin"], `${paths.join("\0")}\0`);
	return new Set(nulFields(text));
}

/** A slash probe forces directory-only matches even for not-yet-created includes. */
async function ignoredDirectories(root: string, paths: readonly string[]): Promise<Set<string>> {
	const ignored = await ignoredPaths(root, paths);
	if (paths.length === 0) return ignored;
	const { text } = await git(root, ["check-ignore", "--no-index", "-v", "-z", "--stdin"], `${paths.map((path) => `${path}/`).join("\0")}\0`);
	const fields = nulFields(text);
	if (fields.length % 4 !== 0) throw new RemoteBuildError({ kind: "ignore-response", reason: "verbose" });
	for (let index = 0; index < fields.length; index += 4) {
		const pattern = fields[index + 2]!;
		const path = fields[index + 3]!.slice(0, -1);
		// abc/** matching abc/ describes a descendant, not the directory abc.
		// Only a directory-only rule can change the no-slash probe's answer.
		if (pattern.endsWith("/")) {
			if (pattern.startsWith("!")) ignored.delete(path);
			else ignored.add(path);
		}
	}
	return ignored;
}

async function optionalFile(path: string, worktree = false): Promise<string | undefined> {
	try {
		// Git follows global excludes symlinks, but not worktree .gitignore symlinks.
		if (worktree && !(await lstat(path)).isFile()) return undefined;
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new RemoteBuildError({ kind: "ignore-read", path }, { cause: error });
	}
}

function literal(path: string): string {
	return path.replace(/[\\*?\[\]{}]/g, "\\$&");
}

/** Git trims only unescaped trailing spaces, not tabs or escaped spaces. */
function trimGitLine(line: string): string {
	let end = line.endsWith("\r") ? line.length - 1 : line.length;
	while (end > 0 && line[end - 1] === " ") {
		let slashes = 0;
		for (let index = end - 2; index >= 0 && line[index] === "\\"; index--) slashes++;
		if (slashes % 2 !== 0) break;
		end--;
	}
	return line.slice(0, end);
}

const characterClasses: Readonly<Record<string, string>> = {
	alnum: "a-zA-Z0-9", alpha: "a-zA-Z", blank: " \t", cntrl: "\x01-\x1f\x7f",
	digit: "0-9", graph: "!-.0-~", lower: "a-z", print: " -.0-~",
	punct: "!-.:-@\\[-`{-~", space: " \t\r\n\v\f", upper: "A-Z", xdigit: "a-fA-F0-9",
};

function foldLetter(character: string, ignoreCase: boolean): string {
	if (ignoreCase && /^[a-zA-Z]$/.test(character)) return `[${character.toLowerCase()}${character.toUpperCase()}]`;
	return /[{}]/.test(character) ? `\\${character}` : character;
}

/** Keep Git glob syntax, escaping doublestar-only brace alternatives. */
function translateGlob(pattern: string, ignoreCase: boolean, source: string): string {
	let result = "";
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index]!;
		if (character === "\\") {
			const next = pattern[++index];
			if (next === undefined) throw new RemoteBuildError({ kind: "ignore-pattern", path: source, reason: "escape" });
			result += /^[a-zA-Z]$/.test(next) ? foldLetter(next, ignoreCase) : `\\${next}`;
		} else if (character === "[") {
			let content = "";
			let negated = "";
			if (pattern[index + 1] === "!" || pattern[index + 1] === "^") negated = pattern[++index]!;
			if (pattern[index + 1] === "]") { content = "\\]"; index++; }
			let closed = false;
			while (++index < pattern.length) {
				const current = pattern[index]!;
				if (current === "]") { closed = true; break; }
				if (current === "\\") {
					const next = pattern[++index];
					if (next === undefined) break;
					content += `\\${next}`;
				} else if (current === "[" && pattern[index + 1] === ":") {
					const end = pattern.indexOf(":]", index + 2);
					const name = end === -1 ? "" : pattern.slice(index + 2, end);
					const expanded = characterClasses[name];
					if (expanded === undefined) throw new RemoteBuildError({ kind: "ignore-pattern", path: source, reason: "class" });
					content += expanded;
					index = end + 1;
				} else content += current;
			}
			if (!closed) throw new RemoteBuildError({ kind: "ignore-pattern", path: source, reason: "unclosed" });
			if (ignoreCase) {
				// Test the positive class, then union opposite-case ASCII letters.
				const expression = new RegExp(`^[${content}]$`, "u");
				let folded = "";
				for (let code = 65; code <= 90; code++) {
					const upper = String.fromCharCode(code);
					const lower = upper.toLowerCase();
					if (expression.test(upper) || expression.test(lower)) folded += upper + lower;
				}
				content += folded;
			}
			// POSIX expansions can start with !, which doublestar reads as negation.
			if (content.startsWith("!") || content.startsWith("^")) content = `\\${content}`;
			result += `[${negated}${content}]`;
		} else result += foldLetter(character, ignoreCase);
	}
	// Git's terminal /** matches contents, while doublestar also matches parent.
	if (result.endsWith("/**")) result += "/*";
	return result;
}

function appendSource(patterns: string[], text: string, scope: string, ignoreCase: boolean, source: string): void {
	for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
		let pattern = trimGitLine(raw);
		if (pattern === "" || pattern.startsWith("#")) continue;
		const negated = pattern.startsWith("!");
		if (negated) pattern = pattern.slice(1);
		if (pattern === "" || pattern === "/") continue;
		const directoryOnly = pattern.endsWith("/");
		if (directoryOnly) pattern = pattern.slice(0, -1);
		const anchored = pattern.startsWith("/");
		if (anchored) pattern = pattern.slice(1);
		// Git patterns with empty/dot path components cannot match real paths.
		if (pattern.split("/").some((part) => part === "" || part === "." || part === "..")) continue;
		const hasSlash = pattern.includes("/");
		// A basename ** is just * in Git; scoped doublestar would match scope itself.
		if (pattern === "**") pattern = "*";
		pattern = translateGlob(pattern, ignoreCase, source);
		if (scope !== "") pattern = `/${literal(scope)}/${anchored || hasSlash ? "" : "**/"}${pattern}`;
		else if (anchored || hasSlash) pattern = `/${pattern}`;
		patterns.push(`${negated ? "!" : ""}${pattern}${directoryOnly ? "/" : ""}`);
	}
}

async function appendWorktreeSources(root: string, patterns: string[], ignoreCase: boolean, scope = ""): Promise<void> {
	const directory = join(root, scope);
	const source = join(directory, ".gitignore");
	const text = await optionalFile(source, true);
	if (text !== undefined) appendSource(patterns, text, scope, ignoreCase, source);
	const children = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && entry.name !== ".git")
		.map((entry) => scope === "" ? entry.name : `${scope}/${entry.name}`)
		.sort();
	const ignored = await ignoredPaths(root, children);
	for (const child of children) {
		if (!ignored.has(child)) await appendWorktreeSources(root, patterns, ignoreCase, child);
	}
}

function ancestors(path: string, result: Set<string>): void {
	let parent = dirname(path);
	while (parent !== ".") {
		result.add(parent);
		parent = dirname(parent);
	}
}

export async function deriveIgnoreRules(root: string, config: RemoteBuildConfig): Promise<MutagenIgnoreRules> {
	const patterns: string[] = [];
	const ignoreCase = (await git(root, ["config", "--type=bool", "--get", "core.ignorecase"])).text.trim() === "true";
	const configured = await git(root, ["config", "-z", "--path", "--get", "core.excludesFile"]);
	const globalPath = configured.code === 0 ? nulFields(configured.text)[0]! : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "ignore");
	if (globalPath !== "") {
		const path = isAbsolute(globalPath) ? globalPath : resolve(root, globalPath);
		const text = await optionalFile(path);
		if (text !== undefined) appendSource(patterns, text, "", ignoreCase, path);
	}
	const exclude = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).text.trimEnd();
	const excludeText = await optionalFile(exclude);
	if (excludeText !== undefined) appendSource(patterns, excludeText, "", ignoreCase, exclude);
	await appendWorktreeSources(root, patterns, ignoreCase);

	// Git's own ignore evaluation over the index: tracked paths matched by the same
	// exclude sources this function translates. Running `check-ignore --no-index`
	// over the full path list would materialize the whole list and an equal-sized
	// stdin blob in the JS heap; `-i --exclude-standard` asks git directly. The
	// result mirrors the previous pipeline's Set: unmerged stages collapse, and
	// pattern order ignores duplicates exactly as before.
	const ignoredTracked = new Set(nulFields((await git(root, ["ls-files", "--cached", "-i", "-z", "--exclude-standard"])).text));
	const parents = new Set<string>();
	for (const path of ignoredTracked) ancestors(path, parents);
	for (const path of config.include) ancestors(path, parents);
	const sortedParents = [...parents].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
	const ignoredParents = await ignoredDirectories(root, sortedParents);
	for (const parent of sortedParents) {
		if (!ignoredParents.has(parent)) continue;
		const path = literal(parent);
		patterns.push(`!/${path}/`, `/${path}/*`);
	}
	for (const path of ignoredTracked) patterns.push(`!/${literal(path)}`);
	for (const path of config.include) {
		const escaped = literal(path.replace(/\/$/, ""));
		patterns.push(`!/${escaped}`, `!/${escaped}/**/*`);
	}
	patterns.push(...config.ignore);
	for (const target of Object.keys(config.containerFiles)) patterns.push(`/${literal(target)}`);
	patterns.push("/.git");
	return { patterns };
}
