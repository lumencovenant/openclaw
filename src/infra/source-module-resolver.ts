/**
 * Resolves TypeScript source siblings for JavaScript specifiers in worker threads.
 *
 * Node's built-in type stripping executes `.ts` files but does not map a relative
 * `./foo.js` specifier to `foo.ts`; that mapping is a TypeScript convention, not an
 * ESM one. OpenClaw workers can load a source plugin domain while their carrier is a
 * compiled `.js` worker, so no tsx loader is installed. This hook supplies only that
 * mapping, synchronously, before the domain module is imported.
 *
 * The hook is installed only when the target module is TypeScript, and an existing
 * `.js` file always wins, preserving Node's normal resolution.
 */
import fs from "node:fs";
import { registerHooks, type ModuleHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const JAVASCRIPT_TO_TYPESCRIPT = new Map([
  [".js", ".ts"],
  [".mjs", ".mts"],
  [".cjs", ".cts"],
]);
const SOURCE_EXTENSION = /\.(?:ts|mts|cts)$/iu;
const MAX_CACHE_ENTRIES = 20_000;

const resolutionCache = new Map<string, string | null>();
let installedHooks: ModuleHooks | undefined;

function splitQueryAndHash(specifier: string): { pathPart: string; suffix: string } {
  const index = specifier.search(/[?#]/u);
  return index === -1
    ? { pathPart: specifier, suffix: "" }
    : { pathPart: specifier.slice(0, index), suffix: specifier.slice(index) };
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isInsideNodeModules(filePath: string): boolean {
  return /[\\/]node_modules[\\/]/u.test(filePath);
}

function resolveUncached(parentUrl: string, specifier: string): string | null {
  if (!parentUrl.startsWith("file:") || !isRelativeSpecifier(specifier)) {
    return null;
  }
  const { pathPart, suffix } = splitQueryAndHash(specifier);
  const extension = path.extname(pathPart);
  const replacement = JAVASCRIPT_TO_TYPESCRIPT.get(extension);
  if (!replacement) {
    return null;
  }
  let parentPath: string;
  try {
    parentPath = fileURLToPath(parentUrl);
  } catch {
    // A malformed or non-file parent URL keeps Node's default resolution.
    return null;
  }
  if (isInsideNodeModules(parentPath)) {
    return null;
  }
  const requestedPath = path.resolve(path.dirname(parentPath), pathPart);
  // An emitted `.js` beside its source is the real module; never shadow it.
  if (fs.existsSync(requestedPath)) {
    return null;
  }
  const candidate = `${requestedPath.slice(0, -extension.length)}${replacement}`;
  return fs.existsSync(candidate) ? `${pathToFileURL(candidate).href}${suffix}` : null;
}

/**
 * Returns the TypeScript source URL for a relative JavaScript specifier, or `null`.
 * Pure apart from the bounded existence cache; safe to call from a resolve hook.
 */
export function resolveSourceSpecifier(
  parentUrl: string | undefined,
  specifier: string,
): string | null {
  if (!parentUrl) {
    return null;
  }
  const key = `${parentUrl}\0${specifier}`;
  const cached = resolutionCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolveUncached(parentUrl, specifier);
  if (resolutionCache.size >= MAX_CACHE_ENTRIES) {
    resolutionCache.clear();
  }
  resolutionCache.set(key, resolved);
  return resolved;
}

/** Installs the synchronous source resolver for this thread. Idempotent. */
export function installSourceModuleResolver(): void {
  if (installedHooks) {
    return;
  }
  installedHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = resolveSourceSpecifier(context.parentURL, specifier);
      return resolved
        ? { url: resolved, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
}

/** Installs the resolver only when the target module is TypeScript. */
export function installSourceModuleResolverFor(moduleUrl: URL): boolean {
  if (!SOURCE_EXTENSION.test(moduleUrl.pathname)) {
    return false;
  }
  installSourceModuleResolver();
  return true;
}

/** Test-only reset; production hooks live for the thread lifetime. */
export function resetSourceModuleResolverForTest(): void {
  installedHooks?.deregister();
  installedHooks = undefined;
  resolutionCache.clear();
}
