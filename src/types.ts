export interface HostConfig {
	readonly ssh: string;
	readonly remoteRoot: string;
	readonly komodo: {
		readonly profile: string;
		readonly server: string;
		readonly cliConfig: string;
	};
	readonly bin: {
		readonly km: string;
		readonly mutagen: string;
	};
}

export type ImageSource =
	| { readonly kind: "configured"; readonly image: string }
	| { readonly kind: "dockerfile"; readonly path: string }
	| { readonly kind: "detect" };

export interface RemoteBuildConfig {
	readonly imageSource: ImageSource;
	readonly bootstrap: string | null;
	readonly workdir: string;
	readonly shell: string;
	readonly ignore: readonly string[];
	readonly include: readonly string[];
	readonly containerFiles: Readonly<Record<string, string>>;
	readonly volumes: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

export type EnvId = string & { readonly __brand: "EnvId" };

export type ProjectId = string & { readonly __brand: "ProjectId" };

export interface DockerfileRef {
	readonly path: string;
	readonly sha256: string;
	readonly text: string;
}

export interface PreparedEnv {
	readonly id: EnvId;
	readonly root: string;
	readonly remotePath: string;
	readonly mutagenSession: string;
	readonly container: string;
	readonly config: RemoteBuildConfig;
	readonly host: HostConfig;
}

export type EnvState =
	| { readonly kind: "preparing"; readonly done: Promise<PreparedEnv> }
	| { readonly kind: "ready"; readonly env: PreparedEnv }
	| { readonly kind: "failed"; readonly error: string };

export interface MutagenIgnoreRules {
	readonly patterns: readonly string[];
}

export interface ContainerSpec {
	readonly name: string;
	readonly image: string;
	readonly workdir: string | null;
	readonly mounts: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

export interface OnceResult {
	readonly exitCode: number;
	readonly output: string;
}

export interface ImageBuildSpec {
	readonly name: string;
	readonly image: string;
	readonly contextPath: string;
	readonly dockerfile: string;
}
