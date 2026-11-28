import { describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createApp, defineJuniorPlugins } from "@/app";
import { unlistedGuardianTools } from "@/chat/plugins/hooks/registry";

const guardian = async () => ({ target: "Demo", audience: "world" as const });

function demoPlugin(hooks: Parameters<typeof defineJuniorPlugin>[0]["hooks"]) {
  return defineJuniorPlugin({
    manifest: {
      name: "demo",
      displayName: "Demo",
      description: "Plugin with Guardian hooks",
    },
    hooks,
  });
}

describe("plugin guardian hooks", () => {
  it("rejects a tool that has a definition in code and in guardian.tools", async () => {
    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          demoPlugin({
            tools: () => ({
              save: {
                description: "Save.",
                inputSchema: {},
                execute: async () => ({}),
              },
            }),
            guardian: { tools: { save: guardian } },
          }),
        ]),
      }),
    ).rejects.toThrow(
      'Plugin "demo" defines tool "save" in code and in guardian.tools',
    );
  });

  it("names guardian.tools entries that the MCP server does not list", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        demoPlugin({
          guardian: { tools: { save_issue: guardian, save_note: guardian } },
        }),
      ]),
    });

    expect(unlistedGuardianTools("demo", ["save_issue", "search"])).toEqual([
      "save_note",
    ]);
  });
});
