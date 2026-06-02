import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/chat/plugins/manifest";

describe("packaged Sentry plugin manifest", () => {
  it("binds credentials only to regional API domains", async () => {
    const pluginDir = path.resolve(process.cwd(), "../junior-sentry");
    const raw = await fs.readFile(path.join(pluginDir, "plugin.yaml"), "utf8");
    const manifest = parsePluginManifest(raw, pluginDir);

    expect(manifest.name).toBe("sentry");
    expect(manifest.credentials?.domains).toEqual([
      "us.sentry.io",
      "de.sentry.io",
    ]);
    expect(manifest.oauth?.authorizeEndpoint).toBe(
      "https://sentry.io/oauth/authorize/",
    );
    expect(manifest.oauth?.tokenEndpoint).toBe(
      "https://sentry.io/oauth/token/",
    );
  });
});
