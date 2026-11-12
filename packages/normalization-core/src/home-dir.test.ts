import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEffectiveHomeDir } from "./home-dir.js";

describe("resolveEffectiveHomeDir", () => {
  it("preserves raw fallback separators until after tilde substitution", () => {
    const env = { HOME: "/home/alice/", OPENCLAW_HOME: "~\\svc" };

    expect(resolveEffectiveHomeDir(env, () => "/fallback")).toBe(path.resolve("/home/alice/\\svc"));
  });

  it("preserves terminal display fallback for unresolved tilde homes", () => {
    const env = { OPENCLAW_HOME: "~" };
    const unavailableHome = () => {
      throw new Error("missing home");
    };

    expect(resolveEffectiveHomeDir(env, unavailableHome)).toBeUndefined();
    expect(resolveEffectiveHomeDir(env, unavailableHome, { preserveUnresolvedTilde: true })).toBe(
      path.resolve("~"),
    );
  });

  it.runIf(process.platform === "win32")("normalizes MSYS home paths on Windows", () => {
    const homedir = () => "C:\\Users\\alice";
    expect(
      resolveEffectiveHomeDir(
        { HOME: "/c/Users/alice", USERPROFILE: "C:\\Users\\alice" },
        homedir,
        { platform: "win32" },
      ),
    ).toBe(path.resolve("C:\\Users\\alice"));
    expect(
      resolveEffectiveHomeDir({ HOME: "/mnt/c/Users/alice" }, homedir, { platform: "win32" }),
    ).toBe(path.resolve("C:\\Users\\alice"));
    expect(
      resolveEffectiveHomeDir({ HOME: "/cygdrive/c/Users/alice" }, homedir, { platform: "win32" }),
    ).toBe(path.resolve("C:\\Users\\alice"));
    expect(
      resolveEffectiveHomeDir({ OPENCLAW_HOME: "/c/Users/alice" }, homedir, { platform: "win32" }),
    ).toBe(path.resolve("C:\\Users\\alice"));
  });
});
