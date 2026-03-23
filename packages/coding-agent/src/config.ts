import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

function normalizeRepositoryUrl(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}

	return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

function mirrorEnvAlias(primary: string, legacy: string): void {
	const primaryValue = process.env[primary];
	const legacyValue = process.env[legacy];

	if (!primaryValue && legacyValue) {
		process.env[primary] = legacyValue;
		return;
	}

	if (primaryValue && !legacyValue) {
		process.env[legacy] = primaryValue;
	}
}

export function detectInstallMethod(): InstallMethod {
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();

	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (isBunRuntime) {
		return "bun";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}

	return "unknown";
}

export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	switch (method) {
		case "bun-binary":
			return `Download from: ${getReleaseInstructionUrl() ?? "the latest release page"}`;
		case "pnpm":
			return `Run: pnpm install -g ${packageName}`;
		case "yarn":
			return `Run: yarn global add ${packageName}`;
		case "bun":
			return `Run: bun install -g ${packageName}`;
		case "npm":
			return `Run: npm install -g ${packageName}`;
		default:
			return `Run: npm install -g ${packageName}`;
	}
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "theme");
	}
	// Theme is in modes/interactive/theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

// =============================================================================
// App Config (from package.json hirocodeConfig, with piConfig fallback)
// =============================================================================

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));
const pkgConfig = pkg.hirocodeConfig ?? pkg.piConfig ?? {};

export const APP_NAME: string = pkgConfig.name || "hirocode";
export const CONFIG_DIR_NAME: string = pkgConfig.configDir || ".hirocode";
export const VERSION: string = pkg.version;
export const PACKAGE_NAME: string = pkg.name;
export const LEGACY_APP_NAME = "pi";
export const LEGACY_CONFIG_DIR_NAME = ".pi";
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_AGENT_DIR_LEGACY = `${LEGACY_APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_PACKAGE_DIR = `${APP_NAME.toUpperCase()}_PACKAGE_DIR`;
export const ENV_PACKAGE_DIR_LEGACY = `${LEGACY_APP_NAME.toUpperCase()}_PACKAGE_DIR`;
export const ENV_OFFLINE = `${APP_NAME.toUpperCase()}_OFFLINE`;
export const ENV_OFFLINE_LEGACY = `${LEGACY_APP_NAME.toUpperCase()}_OFFLINE`;
export const ENV_SKIP_VERSION_CHECK = `${APP_NAME.toUpperCase()}_SKIP_VERSION_CHECK`;
export const ENV_SKIP_VERSION_CHECK_LEGACY = `${LEGACY_APP_NAME.toUpperCase()}_SKIP_VERSION_CHECK`;
export const ENV_SHARE_VIEWER_URL = `${APP_NAME.toUpperCase()}_SHARE_VIEWER_URL`;
export const ENV_SHARE_VIEWER_URL_LEGACY = `${LEGACY_APP_NAME.toUpperCase()}_SHARE_VIEWER_URL`;
export const PACKAGE_REPOSITORY_URL = normalizeRepositoryUrl(pkg.repository?.url);

mirrorEnvAlias(ENV_AGENT_DIR, ENV_AGENT_DIR_LEGACY);
mirrorEnvAlias(ENV_PACKAGE_DIR, ENV_PACKAGE_DIR_LEGACY);
mirrorEnvAlias(ENV_OFFLINE, ENV_OFFLINE_LEGACY);
mirrorEnvAlias(ENV_SKIP_VERSION_CHECK, ENV_SKIP_VERSION_CHECK_LEGACY);
mirrorEnvAlias(ENV_SHARE_VIEWER_URL, ENV_SHARE_VIEWER_URL_LEGACY);

const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

export function getReleaseInstructionUrl(): string | undefined {
	if (!PACKAGE_REPOSITORY_URL) {
		return undefined;
	}

	return `${PACKAGE_REPOSITORY_URL}/releases/latest`;
}

export function isOfflineModeEnabled(): boolean {
	const value = process.env[ENV_OFFLINE] || process.env[ENV_OFFLINE_LEGACY];
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function shouldSkipVersionCheck(): boolean {
	const value = process.env[ENV_SKIP_VERSION_CHECK] || process.env[ENV_SKIP_VERSION_CHECK_LEGACY];
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl =
		process.env[ENV_SHARE_VIEWER_URL] || process.env[ENV_SHARE_VIEWER_URL_LEGACY] || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// User Config Paths (~/.hirocode/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.hirocode/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR] || process.env[ENV_AGENT_DIR_LEGACY];
	if (envDir) {
		// Expand tilde to home directory
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
	const envDir = process.env.HIROCODE_PACKAGE_DIR || process.env.PI_PACKAGE_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}

	if (isBunBinary) {
		return dirname(process.execPath);
	}
	let dir = __dirname;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return __dirname;
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
