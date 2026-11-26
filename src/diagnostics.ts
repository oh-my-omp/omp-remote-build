import { type Language, language } from "../omomp-shared/i18n.ts";

export type Diagnostic =
	| { readonly kind: "host-read"; readonly path: string; readonly detail: string }
	| {
			readonly kind: "config-field";
			readonly path: string;
			readonly field: string;
			readonly reason: "object" | "text" | "unknown" | "absolute" | "host-absolute" | "strings" | "single-line";
	  }
	| { readonly kind: "config-relative"; readonly path: string; readonly field: string; readonly value: string }
	| { readonly kind: "config-image-source"; readonly path: string }
	| { readonly kind: "km-endpoint-read"; readonly path: string }
	| {
			readonly kind: "km-endpoint-field";
			readonly endpoint: string;
			readonly path: string;
			readonly field: "host" | "bao_path" | "key_field" | "secret_field";
	  }
	| { readonly kind: "km-endpoint-url"; readonly endpoint: string; readonly reason: "url" | "components" }
	| { readonly kind: "bao-exec-spawn"; readonly command: string; readonly baoPath: string }
	| { readonly kind: "bao-exec-exit"; readonly baoPath: string; readonly field: string; readonly code: number }
	| { readonly kind: "bao-exec-value"; readonly baoPath: string; readonly field: string }
	| { readonly kind: "komodo-shape"; readonly field: string; readonly expected: "object" | "string" | "boolean" | "number" | "array" }
	| { readonly kind: "komodo-variant"; readonly variant: "image" | "update" }
	| { readonly kind: "komodo-network"; readonly operation: string; readonly host: string }
	| { readonly kind: "komodo-http"; readonly operation: string; readonly status: number }
	| { readonly kind: "komodo-json"; readonly operation: string }
	| { readonly kind: "komodo-value"; readonly reason: "shell" | "command" | "name" | "image" | "workdir" | "volume" | "env" }
	| { readonly kind: "deployment-timeout"; readonly deployment: string; readonly update: string }
	| { readonly kind: "deployment-failed"; readonly deployment: string; readonly update: string }
	| { readonly kind: "deployment-not-running"; readonly deployment: string; readonly state: string }
	| { readonly kind: "container-aborted"; readonly name: string }
	| { readonly kind: "container-disappeared"; readonly name: string }
	| { readonly kind: "container-timeout"; readonly name: string; readonly minutes: number }
	| { readonly kind: "command-exit"; readonly command: string; readonly code: number; readonly output: string }
	| { readonly kind: "ignore-command"; readonly command: string; readonly code: number; readonly output: string }
	| { readonly kind: "ignore-response"; readonly reason: "unterminated" | "verbose" }
	| { readonly kind: "ignore-read"; readonly path: string }
	| { readonly kind: "ignore-pattern"; readonly path: string; readonly reason: "escape" | "class" | "unclosed" }
	| { readonly kind: "mutagen-duplicate"; readonly label: string; readonly ids: readonly string[] }
	| { readonly kind: "mutagen-missing"; readonly id: string }
	| { readonly kind: "move-timeout" };

export function renderDiagnostic(diagnostic: Diagnostic, lang: Language): string {
	const text = (en: string, zh: string): string => (lang === "zh" ? zh : en);
	switch (diagnostic.kind) {
		case "host-read":
			return text(
				`cannot read host config ${diagnostic.path}: ${diagnostic.detail}`,
				`无法读取主机配置 ${diagnostic.path}：${diagnostic.detail}`,
			);
		case "config-field": {
			const { path, field, reason } = diagnostic;
			switch (reason) {
				case "object":
					return text(`${path}: ${field} must be an object`, `${path}：${field} 必须是对象`);
				case "text":
					return text(`${path}: ${field} must be a non-empty string`, `${path}：${field} 必须是非空字符串`);
				case "unknown":
					return text(`${path}: unknown field "${field}"`, `${path}：未知字段“${field}”`);
				case "absolute":
					return text(`${path}: ${field} must be an absolute path`, `${path}：${field} 必须是绝对路径`);
				case "host-absolute":
					return text(`${path}: remoteRoot must be an absolute path on the build host`, `${path}：remoteRoot 必须是构建主机上的绝对路径`);
				case "strings":
					return text(`${path}: ${field} must be an array of strings`, `${path}：${field} 必须是字符串数组`);
				case "single-line":
					return text(`${path}: bootstrap must be a single line`, `${path}：bootstrap 必须只有一行`);
				default: {
					const unhandled: never = reason;
					throw new Error(`Unhandled config field reason ${String(unhandled)}`);
				}
			}
		}
		case "config-relative":
			return text(
				`${diagnostic.path}: ${diagnostic.field} entries must be repo-relative paths without "..": ${diagnostic.value}`,
				`${diagnostic.path}：${diagnostic.field} 的条目必须是相对于仓库的路径，且不含“..”：${diagnostic.value}`,
			);
		case "config-image-source":
			return text(
				`${diagnostic.path}: set at most one of "image" and "dockerfile"`,
				`${diagnostic.path}：“image”和“dockerfile”最多只能设置一个`,
			);
		case "km-config-read":
			return text(`Cannot read or parse km CLI config: ${diagnostic.path}`, `无法读取或解析 km CLI 配置：${diagnostic.path}`);
		case "km-profile-missing":
			return text(
				`km CLI config ${diagnostic.path} has no [[profile]] named "${diagnostic.profile}"`,
				`km CLI 配置 ${diagnostic.path} 中没有名为“${diagnostic.profile}”的 [[profile]]`,
			);
		case "km-profile-field":
			return text(
				`km CLI profile "${diagnostic.profile}" has an invalid ${diagnostic.field} field`,
				`km CLI profile“${diagnostic.profile}”的 ${diagnostic.field} 字段无效`,
			);
		case "km-profile-url":
			return diagnostic.reason === "url"
				? text(
						`km CLI profile "${diagnostic.profile}" host must be an HTTP(S) URL`,
						`km CLI profile“${diagnostic.profile}”的 host 必须是 HTTP(S) URL`,
					)
				: text(
						`km CLI profile "${diagnostic.profile}" host must be an HTTP(S) URL without embedded credentials, query or fragment`,
						`km CLI profile“${diagnostic.profile}”的 host 必须是 HTTP(S) URL，且不能包含内嵌凭据、查询或片段`,
					);
		case "komodo-shape": {
			const { field, expected } = diagnostic;
			switch (expected) {
				case "object":
					return text(`Invalid Komodo response: ${field} must be an object`, `Komodo 响应无效：${field} 必须是对象`);
				case "string":
					return text(`Invalid Komodo response: ${field} must be a string`, `Komodo 响应无效：${field} 必须是字符串`);
				case "boolean":
					return text(`Invalid Komodo response: ${field} must be a boolean`, `Komodo 响应无效：${field} 必须是布尔值`);
				case "number":
					return text(`Invalid Komodo response: ${field} must be a number`, `Komodo 响应无效：${field} 必须是数字`);
				case "array":
					return text(`Invalid Komodo response: ${field} must be an array`, `Komodo 响应无效：${field} 必须是数组`);
				default: {
					const unhandled: never = expected;
					throw new Error(`Unhandled Komodo shape ${String(unhandled)}`);
				}
			}
		}
		case "komodo-variant":
			return diagnostic.variant === "image"
				? text("Invalid Komodo response: unknown Deployment image variant", "Komodo 响应无效：未知的 Deployment 镜像变体")
				: text("Invalid Komodo response: unknown Update status", "Komodo 响应无效：未知的 Update 状态");
		case "komodo-network":
			return text(
				`Komodo ${diagnostic.operation} could not reach Komodo Core ${diagnostic.host} (network failure or 30s request timeout)`,
				`Komodo ${diagnostic.operation} 无法连接 Komodo Core ${diagnostic.host}（网络故障或请求超过 30 秒）`,
			);
		case "komodo-http":
			return text(
				`Komodo ${diagnostic.operation} failed: HTTP ${diagnostic.status}${diagnostic.status === 401 || diagnostic.status === 403 ? " (authentication or authorization failed)" : ""}`,
				`Komodo ${diagnostic.operation} 失败：HTTP ${diagnostic.status}${diagnostic.status === 401 || diagnostic.status === 403 ? "（身份验证或授权失败）" : ""}`,
			);
		case "komodo-json":
			return text(`Komodo ${diagnostic.operation} returned invalid JSON`, `Komodo ${diagnostic.operation} 返回了无效的 JSON`);
		case "komodo-value": {
			const { reason } = diagnostic;
			switch (reason) {
				case "shell":
					return text(
						"Komodo environment and volume values cannot contain CR, LF, NUL or the comment delimiter ' #' (Komodo key/value parser limitation)",
						"Komodo 环境变量和卷的值不能包含 CR、LF、NUL 或注释分隔符 ' #'（Komodo 键值解析器限制）",
					);
				case "command":
					return text("Komodo container command words cannot contain CR, LF or NUL", "Komodo 容器命令参数不能包含 CR、LF 或 NUL");
				case "name":
					return text("Invalid Komodo container name", "Komodo 容器名称无效");
				case "image":
					return text("Invalid Komodo container image reference", "Komodo 容器镜像引用无效");
				case "workdir":
					return text("Komodo container workdir must be an absolute path", "Komodo 容器 workdir 必须是绝对路径");
				case "volume":
					return text(
						"Invalid Komodo volume: expected host-or-volume:container[:mode]",
						"Komodo 卷无效：应为 host-or-volume:container[:mode]",
					);
				case "env":
					return text("Invalid Komodo environment variable name", "Komodo 环境变量名称无效");
				default: {
					const unhandled: never = reason;
					throw new Error(`Unhandled Komodo value reason ${String(unhandled)}`);
				}
			}
		}
		case "deployment-timeout":
			return text(
				`Komodo deployment ${diagnostic.deployment} timed out waiting for Update ${diagnostic.update}`,
				`Komodo deployment ${diagnostic.deployment} 等待 Update ${diagnostic.update} 超时`,
			);
		case "deployment-failed":
			return text(
				`Komodo deployment ${diagnostic.deployment} failed (Update ${diagnostic.update}); inspect the Update in Komodo Core`,
				`Komodo deployment ${diagnostic.deployment} 失败（Update ${diagnostic.update}）；请在 Komodo Core 中查看该 Update`,
			);
		case "deployment-not-running":
			return text(
				`Komodo deployment ${diagnostic.deployment} did not become running within 60s (last state: ${diagnostic.state})`,
				`Komodo deployment ${diagnostic.deployment} 未在 60 秒内开始运行（最后状态：${diagnostic.state}）`,
			);
		case "container-aborted":
			return text(`${diagnostic.name} aborted`, `${diagnostic.name} 已中止`);
		case "container-disappeared":
			return text(`container ${diagnostic.name} disappeared before it exited`, `容器 ${diagnostic.name} 在退出前消失`);
		case "container-timeout":
			return text(
				`${diagnostic.name} still running after ${diagnostic.minutes} min`,
				`${diagnostic.name} 在 ${diagnostic.minutes} 分钟后仍在运行`,
			);
		case "command-exit":
			return text(
				`${diagnostic.command} exited ${diagnostic.code}: ${diagnostic.output}`,
				`${diagnostic.command} 以退出码 ${diagnostic.code} 结束：${diagnostic.output}`,
			);
		case "ignore-command":
			return text(
				`Cannot derive remote-build ignores: git ${diagnostic.command} failed (${diagnostic.code}): ${diagnostic.output}`,
				`无法推导 remote-build 忽略规则：git ${diagnostic.command} 失败（${diagnostic.code}）：${diagnostic.output}`,
			);
		case "ignore-response":
			return diagnostic.reason === "unterminated"
				? text(
						"Git returned an unterminated path list while deriving remote-build ignores",
						"推导 remote-build 忽略规则时 Git 返回了未终止的路径列表",
					)
				: text("Git returned an invalid verbose ignore response", "Git 返回了无效的详细忽略响应");
		case "ignore-read":
			return text(`Cannot read Git ignore file ${diagnostic.path}`, `无法读取 Git 忽略文件 ${diagnostic.path}`);
		case "ignore-pattern": {
			const { reason } = diagnostic;
			switch (reason) {
				case "escape":
					return text(
						`Unsupported trailing escape in Git ignore file ${diagnostic.path}`,
						`Git 忽略文件 ${diagnostic.path} 中有不支持的末尾转义`,
					);
				case "class":
					return text(
						`Unsupported character class in Git ignore file ${diagnostic.path}`,
						`Git 忽略文件 ${diagnostic.path} 中有不支持的字符类`,
					);
				case "unclosed":
					return text(
						`Unclosed character class in Git ignore file ${diagnostic.path}`,
						`Git 忽略文件 ${diagnostic.path} 中有未闭合的字符类`,
					);
				default: {
					const unhandled: never = reason;
					throw new Error(`Unhandled ignore pattern reason ${String(unhandled)}`);
				}
			}
		}
		case "mutagen-duplicate":
			return text(
				`multiple Mutagen sessions labelled ${diagnostic.label}: ${diagnostic.ids.join(", ")}`,
				`多个 Mutagen 会话带有标签 ${diagnostic.label}：${diagnostic.ids.join(", ")}`,
			);
		case "mutagen-missing":
			return text(`Mutagen session rb-${diagnostic.id} not found after creation`, `创建后找不到 Mutagen 会话 rb-${diagnostic.id}`);
		case "move-timeout":
			return text("/worktree did not move the session; no environment prepared", "/worktree 未移动会话；未准备环境");
	}
}

export class RemoteBuildError extends Error {
	constructor(
		readonly diagnostic: Diagnostic,
		options?: ErrorOptions,
	) {
		super(renderDiagnostic(diagnostic, "en"), options);
		this.name = "RemoteBuildError";
	}
}

export function humanErrorMessage(error: unknown): string {
	return error instanceof RemoteBuildError
		? renderDiagnostic(error.diagnostic, language())
		: error instanceof Error
			? error.message
			: String(error);
}
