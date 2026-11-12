import os from "node:os";
import path from "node:path";

export function normalizeHomeDirValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalizeHomeDirValue(homedir());
  } catch {
    return undefined;
  }
}

function resolveTermuxHome(env: NodeJS.ProcessEnv): string | undefined {
  const prefix = normalizeHomeDirValue(env.PREFIX);
  if (!prefix || !normalizeHomeDirValue(env.ANDROID_DATA)) {
    return undefined;
  }
  if (!/(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replace(/\\/gu, "/"))) {
    return undefined;
  }
  return path.resolve(prefix, "..", "home");
}

// Git Bash, Cygwin, and WSL expose the Windows drive as `/c/...`, `/cygdrive/c/...`,
// or `/mnt/c/...`. Resolving those as host paths on win32 invents a `D:\c\...` tree.
const WINDOWS_MSYS_HOME = /^\/(?:(?:cygdrive|mnt)\/)?([a-zA-Z])\/(.*)$/u;

function normalizeWindowsMsysHome(value: string): string {
  const match = WINDOWS_MSYS_HOME.exec(value);
  const drive = match?.[1]?.toUpperCase();
  if (!drive) {
    return value;
  }
  const rest = (match?.[2] ?? "").replaceAll("/", "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

function normalizeRawHome(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const normalized = normalizeHomeDirValue(value);
  return normalized && platform === "win32" ? normalizeWindowsMsysHome(normalized) : normalized;
}

function resolveRawOsHomeDir(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
  platform: NodeJS.Platform,
): string | undefined {
  return (
    normalizeRawHome(env.HOME, platform) ??
    normalizeRawHome(env.USERPROFILE, platform) ??
    resolveTermuxHome(env) ??
    normalizeSafe(homedir)
  );
}

export function resolveOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const raw = resolveRawOsHomeDir(env, homedir, platform);
  return raw ? path.resolve(raw) : undefined;
}

export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  options?: { preserveUnresolvedTilde?: boolean; platform?: NodeJS.Platform },
): string | undefined {
  const platform = options?.platform ?? process.platform;
  const explicitHome = normalizeRawHome(env.OPENCLAW_HOME, platform);
  if (!explicitHome) {
    return resolveOsHomeDir(env, homedir, platform);
  }
  if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
    const osHome = resolveRawOsHomeDir(env, homedir, platform);
    if (!osHome) {
      return options?.preserveUnresolvedTilde ? path.resolve(explicitHome) : undefined;
    }
    return path.resolve(explicitHome.replace(/^~(?=$|[\\/])/, () => osHome));
  }
  return path.resolve(explicitHome);
}
