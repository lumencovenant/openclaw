/** Behavior-neutral startup stage sums for the gateway plugin load. */
export type PluginLoadStageMetrics = {
  artifactMs: number;
  configMs: number;
  importMs: number;
  prepareMs: number;
  bindMs: number;
};

export function createPluginLoadStageMetrics(): PluginLoadStageMetrics {
  return {
    artifactMs: 0,
    configMs: 0,
    importMs: 0,
    prepareMs: 0,
    bindMs: 0,
  };
}
