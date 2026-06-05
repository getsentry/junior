import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/chat/plugins/manifest";

describe("packaged Sentry plugin manifest", () => {
  it("binds credentials to sentry.io and regional API domains", async () => {
    const pluginDir = path.resolve(process.cwd(), "../junior-sentry");
    const raw = await fs.readFile(path.join(pluginDir, "plugin.yaml"), "utf8");
    const manifest = parsePluginManifest(raw, pluginDir);

    expect(manifest.name).toBe("sentry");
    // sentry.io must be included: the Sentry CLI calls sentry.io for all API
    // requests by default. The egress proxy uses exact hostname matching, so
    // omitting sentry.io causes the CLI to send the placeholder token directly
    // to Sentry instead of having the real credential injected. See #534.
    expect(manifest.credentials?.domains).toEqual([
      "sentry.io",
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
