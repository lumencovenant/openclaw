// State-directory lookup without initializing process-wide config paths.
import os from "node:os";
import path from "node:path";
import { normalizeProfileName, resolveProfileStateDir } from "../cli/profile-utils.js";
import { resolveHomeRelativePath, resolveRequiredHomeDir } from "../infra/home-dir.js";
import { LruCache } from "../infra/lru-cache.js";

const absoluteStateDirs = new LruCache<string>(64);

// Native Windows shells expose the same directory as `/c/...`, `/cygdrive/c/...`,
// or `/mnt/c/...`; a drive-relative `D:foo` depends on that drive's current directory.
const WINDOWS_MSYS_STATE_DIR = /^\/(?:(?:cygdrive|mnt)\/)?([a-zA-Z])\/(.*)$/u;
const WINDOWS_DRIVE_RELATIVE_STATE_DIR = /^([a-zA-Z]):([^\\/].*)$/u;

function normalizeStateDirOverride(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (!value || platform !== "win32") {
    return value;
  }
  const msys = WINDOWS_MSYS_STATE_DIR.exec(value);
  const msysDrive = msys?.[1]?.toUpperCase();
  if (msysDrive) {
    return `${msysDrive}:\\${(msys?.[2] ?? "").replaceAll("/", "\\")}`;
  }
  const driveRelative = WINDOWS_DRIVE_RELATIVE_STATE_DIR.exec(value);
  const relativeDrive = driveRelative?.[1]?.toUpperCase();
  return relativeDrive
    ? `${relativeDrive}:\\${driveRelative?.[2] ?? ""}`
    : value;
}

/** Root-relative Windows paths (`/custom/state`) depend on the current drive. */
function isPinnedStateDirPath(value: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    return /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith("\\\\");
  }
  return path.isAbsolute(value);
}

export function resolveLegacyStateDirs(homedir: () => string = resolveRequiredHomeDir): string[] {
  return [path.join(homedir(), ".clawdbot")];
}

export function resolveNewStateDir(homedir: () => string = resolveRequiredHomeDir): string {
  return path.join(homedir(), ".openclaw");
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via OPENCLAW_STATE_DIR.
 * Default: ~/.openclaw, or ~/.openclaw-<profile> for a named profile.
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = normalizeStateDirOverride(
    env.OPENCLAW_STATE_DIR?.trim(),
    process.platform,
  );
  // Startup pins this absolute override. Other forms still observe home, cwd,
  // and the updater's invocation base.
  if (override && isPinnedStateDirPath(override, process.platform)) {
    const cached = absoluteStateDirs.peek(override);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = path.resolve(override);
    absoluteStateDirs.set(override, resolved);
    return resolved;
  }
  if (override) {
    return resolveHomeRelativePath(override, { env, homedir });
  }
  return resolveStateDirFromHome(env, () => resolveRequiredHomeDir(env, homedir));
}

/** Select a default state directory from the caller's already resolved home. */
export function resolveStateDirFromHome(
  env: NodeJS.ProcessEnv,
  effectiveHomedir: () => string,
): string {
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  return profile
    ? resolveProfileStateDir(profile, env, effectiveHomedir)
    : resolveNewStateDir(effectiveHomedir);
}
