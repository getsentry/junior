import fs from "node:fs";
import { describe, expect, it } from "vitest";
import tsupConfig from "../../../tsup.config";

function getTsupEntryNames(): string[] {
  const config = Array.isArray(tsupConfig) ? tsupConfig[0] : tsupConfig;

  if (!config || typeof config !== "object" || !("entry" in config)) {
    throw new Error("tsup config must expose entry points");
  }

  return Object.keys(config.entry as Record<string, string>);
}

describe("CLI package build contract", () => {
  it("builds every CLI module loaded by the package bin", () => {
    const binScript = fs.readFileSync(
      new URL("../../../bin/junior.mjs", import.meta.url),
      "utf8",
    );
    const loadedCliEntries = [
      ...new Set(
        [...binScript.matchAll(/loadCliFunction\(\s*"([^"]+)"/g)].map(
          ([, moduleName]) => `cli/${moduleName}`,
        ),
      ),
    ];

    expect(loadedCliEntries.length).toBeGreaterThan(0);
    expect(getTsupEntryNames()).toEqual(
      expect.arrayContaining(loadedCliEntries),
    );
  });
});
