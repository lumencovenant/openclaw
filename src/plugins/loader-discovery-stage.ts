import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import type { PluginLoadCacheContext } from "./loader-load-context.js";
import { createPluginCandidatesFromManifestRegistry } from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "./manifest-registry.js";

/** Discovery and manifest selection are startup stages with independent cost. */
export function loadPluginDiscoveryStage(params: {
  options: PluginLoadOptions;
  context: PluginLoadCacheContext;
}): {
  discovery: PluginDiscoveryResult;
  manifestRegistry: PluginManifestRegistry;
  scanMs: number;
  manifestMs: number;
} {
  const { options, context } = params;
  const suppliedManifestRegistry =
    options.manifestRegistry ??
    (options.discovery === undefined ? context.metadataSnapshot?.manifestRegistry : undefined);
  const scanStartedAt = performance.now();
  const discovery: PluginDiscoveryResult = suppliedManifestRegistry
    ? {
        candidates: createPluginCandidatesFromManifestRegistry(suppliedManifestRegistry),
        diagnostics: [],
      }
    : (options.discovery ??
      discoverOpenClawPlugins({
        workspaceDir: options.workspaceDir,
        extraPaths: context.normalized.loadPaths,
        env: context.env,
        installRecords: context.installRecords,
      }));
  const scanMs = performance.now() - scanStartedAt;
  const manifestStartedAt = performance.now();
  const manifestRegistry =
    suppliedManifestRegistry ??
    loadPluginManifestRegistryCore({
      config: context.cfg,
      workspaceDir: options.workspaceDir,
      env: context.env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
      installRecords:
        Object.keys(context.installRecords).length > 0 ? context.installRecords : undefined,
    });
  return {
    discovery,
    manifestRegistry,
    scanMs,
    manifestMs: performance.now() - manifestStartedAt,
  };
}
