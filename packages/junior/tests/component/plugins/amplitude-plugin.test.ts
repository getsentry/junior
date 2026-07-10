import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { listToolsMock } = vi.hoisted(() => ({
  listToolsMock: vi.fn(),
}));

vi.mock("@/chat/mcp/client", () => ({
  McpAuthorizationRequiredError: class extends Error {},
  PluginMcpClient: class {
    async listTools() {
      return await listToolsMock();
    }

    async close() {}
  },
}));

import { McpToolManager } from "@/chat/mcp/tool-manager";

const originalCwd = process.cwd();
const readOnlyTools = [
  "search",
  "get_from_url",
  "get_context",
  "get_project_context",
  "get_workspace_context",
  "get_charts",
  "get_dashboard",
  "get_cohorts",
  "get_experiments",
  "get_users",
  "get_flags",
  "get_deployments",
  "get_agent_results",
  "get_events",
  "get_properties",
  "get_custom_or_labeled_events",
  "get_transformations",
  "get_group_types",
  "get_session_replays",
  "list_session_replays",
  "get_session_replay_events",
  "query_chart",
  "query_charts",
  "query_amplitude_data",
  "query_experiment",
  "get_cohort_sync_destinations",
  "get_cohort_syncs",
  "get_cohort_sync_history",
  "get_branches",
  "list_guides_surveys",
  "get_guide_or_survey",
  "get_feedback_insights",
  "get_feedback_comments",
  "get_feedback_mentions",
  "get_feedback_sources",
  "get_feedback_trends",
  "query_agent_analytics_metrics",
  "query_agent_analytics_sessions",
  "query_agent_analytics_spans",
  "get_agent_analytics_conversation",
  "search_agent_analytics_conversations",
  "get_agent_analytics_schema",
];

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.doUnmock("@/chat/discovery");
  listToolsMock.mockReset();
});

describe("Amplitude plugin package", () => {
  it("discovers the shipped manifest and exposes only allowlisted MCP tools", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-amplitude-package-"),
    );
    const packageRoot = path.join(
      tempRoot,
      "node_modules",
      "@sentry",
      "junior-amplitude",
    );
    await fs.mkdir(path.dirname(packageRoot), { recursive: true });
    await fs.cp(
      path.resolve(import.meta.dirname, "../../../../junior-amplitude"),
      packageRoot,
      { recursive: true },
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "amplitude-test-app",
        private: true,
        dependencies: { "@sentry/junior-amplitude": "0.94.0" },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/discovery", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/chat/discovery")>()),
      pluginRoots: () => [],
    }));

    const { pluginCatalogRuntime } =
      await import("@/chat/plugins/catalog-runtime");
    pluginCatalogRuntime.setConfig({
      packages: ["@sentry/junior-amplitude"],
    });
    const providers = pluginCatalogRuntime.getProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.mcp).toMatchObject({
      url: "https://mcp.amplitude.com/mcp",
    });
    const allowedTools = providers[0]?.manifest.mcp?.allowedTools;
    expect(allowedTools).toEqual(readOnlyTools);

    listToolsMock.mockResolvedValue([
      ...readOnlyTools.map((name) => ({
        name,
        description: `Amplitude ${name}`,
        inputSchema: { type: "object", properties: {} },
      })),
      {
        name: "create_dashboard",
        description: "Create a dashboard",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    const manager = new McpToolManager(providers);
    await manager.activateProvider("amplitude");

    expect(manager.getActiveToolCatalog().map((tool) => tool.rawName)).toEqual(
      readOnlyTools,
    );
  });
});
