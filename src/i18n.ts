export type Language = "en" | "zh";

/** The environment variable that explicitly selects the UI language. */
export const LANGUAGE_ENV = "OMOMP_LANG";

/** Resolves a language value from an explicit environment setting. */
function parseLanguage(value: unknown): Language | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "en" || normalized === "zh" ? normalized : undefined;
}

/**
 * Resolves the current process language. The environment is read on each call,
 * so changes apply without restarting the process.
 */
export function language(): Language {
	const explicit = parseLanguage(process.env[LANGUAGE_ENV]);
	if (explicit !== undefined) return explicit;

	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
		const locale = process.env[key]?.trim();
		if (locale) return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** The person-facing text for this process's current language; English is written first. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
