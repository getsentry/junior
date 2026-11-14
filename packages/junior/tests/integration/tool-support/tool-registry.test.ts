import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { promptModeTurnTools } from "@/chat/conversations/kind-behavior";
import { closeDb } from "@/chat/db";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import { readSlackActionToken } from "@/chat/slack/action-token";
import type { PromptMode } from "@/chat/system-prompt-rules";
import { createTools } from "@/chat/tools";
import type { ToolRegistry } from "@/chat/tools/definition";
import {
  RUN_BUILT_TOOL_NAMES,
  staticToolDefinitions,
} from "@/chat/tools/registry";

type ToolContext = Parameters<typeof createTools>[2];

const MODES: PromptMode[] = ["conversation", "child_agent", "automation"];
const PLATFORMS = ["slack", "local"] as const;

async function unavailable(): Promise<never> {
  throw new Error("not used by this test");
}

// A public Conversation with every run capability, so `createTools` builds
// each tool that a Turn of this mode can get. Operator tools, which need a
// private Conversation, are off in tests.
function fullContext(
  platform: (typeof PLATFORMS)[number],
  mode: PromptMode,
): ToolContext {
  const base = {
    conversationPrivacy: "public" as const,
    egress: { fetch: unavailable },
    turnTools: promptModeTurnTools(mode),
    workspace: {
      createPreview: unavailable,
      readFileToBuffer: unavailable,
      runCommand: unavailable,
      writeFiles: unavailable,
    },
    attachmentStorage: createMemoryAttachmentStorage(),
    spawnAgent: unavailable,
    messageAgent: unavailable,
    mcpToolManager: new McpToolManager([]),
    supportsImageInput: () => true,
    workspaces: { activeWorkspaceId: () => undefined, switch: unavailable },
  };
  if (platform === "local") {
    return {
      ...base,
      conversationId: "local:registry",
      destination: { platform, conversationId: "local:registry" },
      source: createLocalSource("local:registry"),
    };
  }
  const address = { teamId: "T0", channelId: "C0" };
  return {
    ...base,
    actor: { platform, teamId: "T0", userId: "U0" },
    conversationId: "slack:T0:C0:1.0",
    destination: { platform, ...address, threadTs: "1.0" },
    slackActionToken: readSlackActionToken({
      raw: { action_token: "action-1" },
    }),
    source: createSlackSource({ ...address, visibility: "public" }),
  };
}

// The fields that the provider request and the tool plan read. Functions and
// the run's disabled reason are bound per run.
function modelFacing(tools: ToolRegistry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const { disabledReason: _disabledReason, ...definition } = tool;
      return [name, JSON.parse(JSON.stringify(definition))];
    }),
  );
}

describe("static tool registry", () => {
  beforeAll(async () => {
    await createApp({
      plugins: defineJuniorPlugins([githubPlugin(), memoryPlugin()]),
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it.each(
    PLATFORMS.flatMap((platform) =>
      MODES.map((mode) => [platform, mode] as const),
    ),
  )(
    "holds the definitions that createTools sends on %s in %s mode",
    (platform, mode) => {
      const built = createTools(
        [],
        { writeGeneratedArtifacts: () => [] },
        fullContext(platform, mode),
      );
      const staticBuilt = Object.fromEntries(
        Object.entries(built).filter(
          ([name]) => !RUN_BUILT_TOOL_NAMES.includes(name),
        ),
      );

      const definitions = staticToolDefinitions({ platform, mode });

      expect(Object.keys(definitions)).toEqual(Object.keys(staticBuilt));
      expect(modelFacing(definitions)).toEqual(modelFacing(staticBuilt));
    },
  );

  // A stale run-built name would hide a static tool from the check above.
  it("builds every run-built tool for a run with each capability", () => {
    const built = new Set(
      PLATFORMS.flatMap((platform) =>
        MODES.flatMap((mode) =>
          Object.keys(
            createTools(
              [],
              { writeGeneratedArtifacts: () => [] },
              fullContext(platform, mode),
            ),
          ),
        ),
      ),
    );

    expect(RUN_BUILT_TOOL_NAMES.filter((name) => !built.has(name))).toEqual([]);
  });
});
