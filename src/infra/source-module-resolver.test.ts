import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  installSourceModuleResolverFor,
  resetSourceModuleResolverForTest,
  resolveSourceSpecifier,
} from "./source-module-resolver.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => resetSourceModuleResolverForTest());

function writeFixture(root: string): void {
  fs.writeFileSync(path.join(root, "kernel.ts"), "export const value = 'kernel-ok';\n");
  fs.writeFileSync(
    path.join(root, "domain.ts"),
    'import { value } from "./kernel.js";\nexport const result = value;\n',
  );
}

function parentUrlFor(root: string): string {
  return pathToFileURL(path.join(root, "domain.ts")).href;
}

describe("source module resolver", () => {
  it("maps a relative .js specifier to its TypeScript sibling", () => {
    const root = tempDirs.make("openclaw-source-resolver-");
    writeFixture(root);

    const expected = pathToFileURL(path.join(root, "kernel.ts")).href;
    expect(resolveSourceSpecifier(parentUrlFor(root), "./kernel.js")).toBe(expected);
    expect(resolveSourceSpecifier(parentUrlFor(root), "./kernel.js?raw=1")).toBe(`${expected}?raw=1`);
    expect(resolveSourceSpecifier(parentUrlFor(root), "./kernel.js#fragment")).toBe(
      `${expected}#fragment`,
    );
  });

  it("keeps an emitted .js sibling instead of shadowing it", () => {
    const root = tempDirs.make("openclaw-source-resolver-shadow-");
    writeFixture(root);
    fs.writeFileSync(path.join(root, "kernel.js"), "export const value = 'built';\n");

    expect(resolveSourceSpecifier(parentUrlFor(root), "./kernel.js")).toBeNull();
  });

  it("ignores bare specifiers and node_modules source", () => {
    const root = tempDirs.make("openclaw-source-resolver-bare-");
    writeFixture(root);
    expect(resolveSourceSpecifier(parentUrlFor(root), "openclaw/plugin-sdk/x.js")).toBeNull();

    const nested = path.join(root, "node_modules", "pkg");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "kernel.ts"), "export const value = 1;\n");
    const nestedParent = pathToFileURL(path.join(nested, "domain.ts")).href;
    expect(resolveSourceSpecifier(nestedParent, "./kernel.js")).toBeNull();
  });

  it("resolves paths containing spaces and non-ASCII characters", () => {
    const root = tempDirs.make("openclaw source 猫-");
    writeFixture(root);

    expect(resolveSourceSpecifier(parentUrlFor(root), "./kernel.js")).toBe(
      pathToFileURL(path.join(root, "kernel.ts")).href,
    );
  });

  it("installs only for TypeScript targets and stays idempotent", () => {
    expect(installSourceModuleResolverFor(pathToFileURL("worker.js"))).toBe(false);
    expect(installSourceModuleResolverFor(pathToFileURL("worker.ts"))).toBe(true);
    expect(installSourceModuleResolverFor(pathToFileURL("worker.ts"))).toBe(true);
  });

  it("lets a loader-free Node process import a TypeScript domain", async () => {
    const root = tempDirs.make("openclaw-source-resolver-runtime-");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    writeFixture(root);

    const resolverPath = fileURLToPath(new URL("./source-module-resolver.ts", import.meta.url));
    await build({
      entryPoints: [resolverPath],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(root, "resolver.mjs"),
      logLevel: "silent",
    });
    fs.writeFileSync(
      path.join(root, "runner.mjs"),
      [
        'import { installSourceModuleResolver } from "./resolver.mjs";',
        "installSourceModuleResolver();",
        'const mod = await import("./domain.ts");',
        "console.log(JSON.stringify({ result: mod.result }));",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(root, "control.mjs"),
      [
        'const mod = await import("./domain.ts");',
        "console.log(JSON.stringify({ result: mod.result }));",
        "",
      ].join("\n"),
    );

    const installed = await execFileAsync(process.execPath, ["runner.mjs"], { cwd: root });
    expect(JSON.parse(installed.stdout)).toEqual({ result: "kernel-ok" });

    await expect(
      execFileAsync(process.execPath, ["control.mjs"], { cwd: root }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("ERR_MODULE_NOT_FOUND"),
    });
  });
});
