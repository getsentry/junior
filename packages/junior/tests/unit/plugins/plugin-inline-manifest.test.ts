import { describe, expect, it } from "vitest";
import { parseInlinePluginManifest } from "@/chat/plugins/manifest";
import type { PluginManifest } from "@/chat/plugins/types";

function parse(manifest: unknown): PluginManifest {
  return parseInlinePluginManifest(
    manifest as PluginManifest,
    "/plugins/inline",
  );
}

describe("inline plugin manifests", () => {
  it("rejects invalid values instead of dropping them before validation", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "capabilities",
        { capabilities: null },
        "Plugin bad-capabilities capabilities must be an array when provided",
      ],
      [
        "config-keys",
        { configKeys: null },
        "Plugin bad-config-keys config-keys must be an array when provided",
      ],
      [
        "credentials",
        { credentials: null },
        "Plugin bad-credentials credentials must be an object when provided",
      ],
      ["mcp", { mcp: null }, "Plugin bad-mcp mcp must be an object"],
      ["oauth", { oauth: null }, "Plugin bad-oauth oauth must be an object"],
      [
        "target",
        { target: null },
        "Plugin bad-target target must be an object",
      ],
    ];

    for (const [name, patch, message] of cases) {
      expect(() =>
        parse({
          name: `bad-${name}`,
          description: "Bad inline manifest",
          ...patch,
        }),
      ).toThrow(message);
    }
  });

  it("lets the manifest parser report malformed inline tokens", () => {
    expect(() =>
      parse({
        name: "bad-capability-token",
        description: "Bad inline manifest",
        capabilities: [123],
      }),
    ).toThrow("Invalid input: expected string");

    expect(() =>
      parse({
        name: "bad-target-token",
        description: "Bad inline manifest",
        configKeys: ["repo"],
        target: {
          type: "repo",
          configKey: 123,
        },
      }),
      ).toThrow("Plugin bad-target-token target.config-key Invalid input");
  });

  it("accepts camelCase command env exposure declarations", () => {
    const manifest = parse({
      name: "safe-env",
      description: "Safe sandbox env",
      envVars: {
        EXAMPLE_SAFE_TOKEN: { exposeToCommandEnv: true },
      },
      commandEnv: {
        EXAMPLE_SAFE_TOKEN: "${EXAMPLE_SAFE_TOKEN}",
      },
    });

    expect(manifest.envVars).toEqual({
      EXAMPLE_SAFE_TOKEN: { exposeToCommandEnv: true },
    });
    expect(manifest.commandEnv).toEqual({
      EXAMPLE_SAFE_TOKEN: "${EXAMPLE_SAFE_TOKEN}",
    });
  });
});
