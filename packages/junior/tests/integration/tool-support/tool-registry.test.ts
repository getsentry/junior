import {
  createEventSource,
  createLocalSource,
  createSlackSource,
  createWebSource,
} from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { memoryPlugin } from "@sentry/junior-memory";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { promptPlatform } from "@/chat/agent/prompt";
import { bindTurnTools } from "@/chat/agent/tools";
import type { AgentRun } from "@/chat/agent/types";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import {
  promptModeTurnTools,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";
import { closeDb } from "@/chat/db";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import { buildTurnContextPrompt } from "@/chat/prompt";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { readSlackActionToken } from "@/chat/slack/action-token";
import { buildDeploymentSystemPrompt } from "@/chat/system-prompt";
import type { PromptMode } from "@/chat/system-prompt-rules";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";
import { createTools } from "@/chat/tools";
import type { ToolRegistry } from "@/chat/tools/definition";
import {
  RUN_BUILT_TOOL_NAMES,
  staticToolDefinitions,
} from "@/chat/tools/registry";

type ToolContext = Parameters<typeof createTools>[2];

const MODES: PromptMode[] = [
  "conversation",
  "child_agent",
  "automation",
  "thread",
  "lead",
];
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
    // Memory storage cannot sign download URLs. Production storage can.
    attachmentStorage: {
      ...createMemoryAttachmentStorage(),
      createDownloadUrl: unavailable,
    },
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

const plugins = () => defineJuniorPlugins([githubPlugin(), memoryPlugin()]);

// A Turn's run as the agent gets it: a person's Turn runs on the
// Conversation loop with a Delivery, and any other Turn has none. All have
// the same Slack Location.
function turnRun(
  conversationId: string,
  personInput: boolean,
  otherSource: AgentRun["source"],
) {
  const spawnAgent = vi.fn(unavailable);
  const messageAgent = vi.fn(unavailable);
  const run: AgentRun = {
    conversationId,
    turnId: `turn-${personInput}`,
    instruction: { text: "hello" },
    source: personInput ? createWebSource(conversationId) : otherSource,
    destination: { platform: "slack", teamId: "T0", channelId: "C0" },
    location: {
      id: "location:T0:C0:1.0",
      provider: "slack",
      teamId: "T0",
      channelId: "C0",
      threadTs: "1.0",
    },
    ...(personInput ? { delivery: async () => {} } : undefined),
    environment: {
      bindSpawnAgent: () => spawnAgent,
      bindMessageAgent: () => messageAgent,
    },
  };
  return { messageAgent, run, spawnAgent };
}

// The tools and system prompt that one Turn sends.
async function sentTurn(
  behavior: ReturnType<typeof turnBehavior>,
  { run, spawnAgent, messageAgent }: ReturnType<typeof turnRun>,
) {
  const tools = createTools(
    [],
    { writeGeneratedFiles: () => [] },
    {
      ...fullContext("slack", behavior.promptMode),
      ...bindTurnTools(run, behavior),
    },
  );
  return {
    disabled: Object.keys(tools).filter((name) => tools[name]!.disabledReason),
    messageAgent,
    piTools: createPiAgentTools(tools, new SkillSandbox([], []), {
      spanContext: {},
      searchToolsCost: { owner: "none" },
    }),
    sender: behavior.sender!,
    spawnAgent,
    systemPrompt: await buildDeploymentSystemPrompt(
      promptPlatform(run, behavior.promptMode),
      behavior.promptMode,
    ),
    tools,
  };
}

type SentTurn = Awaited<ReturnType<typeof sentTurn>>;

// The tool adapter refuses a disabled tool before it runs.
function callTool(
  turn: SentTurn,
  name: string,
  input: Record<string, unknown> = {},
) {
  const direct = turn.piTools.find((tool) => tool.name === name);
  return direct
    ? direct.execute(`${name}-call`, input)
    : turn.piTools
        .find((tool) => tool.name === "executeTool")!
        .execute(`${name}-call`, { tool_name: name, arguments: input });
}

// The same system prompt, tool names, and model-facing definitions.
function expectSameCachedPrefix(turns: SentTurn[]) {
  for (const turn of turns.slice(1)) {
    expect(turn.systemPrompt).toBe(turns[0]!.systemPrompt);
    expect(Object.keys(turn.tools)).toEqual(Object.keys(turns[0]!.tools));
    expect(modelFacing(turn.tools)).toEqual(modelFacing(turns[0]!.tools));
  }
}

// The Turn context states the sender, and holds no rules.
function turnInputFact(turn: SentTurn) {
  return buildTurnContextPrompt({
    includeSessionContext: false,
    turnInput: turn.sender,
  });
}

describe("static tool registry", () => {
  beforeAll(async () => {
    await createApp({ plugins: plugins() });
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
        { writeGeneratedFiles: () => [] },
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

  // A person and an agent both send Turns to a Thread. Every switch between
  // them must keep the cached tools and system prompt, but each Turn still
  // cannot run the tools of the other sender.
  it("sends one system prompt and one tool list on every Turn of a Thread", async () => {
    await createApp({ plugins: plugins(), limits: { maxAgentDepth: 1 } });
    try {
      const [person, agent] = await Promise.all(
        [true, false].map((personInput) =>
          sentTurn(
            turnBehavior({ kind: "thread", personInput }),
            turnRun("slack:T0:C0:1.0:thread", personInput, {
              kind: "agent_invocation",
            }),
          ),
        ),
      ).then((turns) => turns as [SentTurn, SentTurn]);

      expectSameCachedPrefix([person, agent]);
      expect(person.disabled).toEqual(
        expect.arrayContaining([
          "spawnAgent",
          "stopAgent",
          "archiveAgent",
          "listAgents",
          "messageAgent",
          "reply",
          "reportBlocked",
        ]),
      );
      expect(person.disabled).not.toContain("addReviewItem");
      expect(agent.disabled).toEqual(
        expect.arrayContaining([
          "setConversationSubscription",
          "addReviewItem",
          "searchReviewItems",
          "updateReviewItem",
        ]),
      );
      expect(agent.disabled).not.toContain("spawnAgent");
      expect(agent.disabled).not.toContain("reply");

      for (const name of ["spawnAgent", "messageAgent", "reply"]) {
        await expect(callTool(person, name)).rejects.toThrow(
          `${name} is disabled in this Turn.`,
        );
      }
      await expect(
        callTool(agent, "setConversationSubscription", { subscribed: true }),
      ).rejects.toThrow(
        "setConversationSubscription is disabled in this Turn.",
      );
      await expect(callTool(agent, "addReviewItem")).rejects.toThrow(
        "addReviewItem is disabled in this Turn.",
      );
      expect(person.spawnAgent).not.toHaveBeenCalled();
      expect(person.messageAgent).not.toHaveBeenCalled();

      expect(turnInputFact(person)).toContain(
        "<turn-input>\nA person sent the input of this Turn.\n</turn-input>",
      );
      expect(turnInputFact(agent)).toContain(
        "<turn-input>\nAn agent sent the input of this Turn.\n</turn-input>",
      );
    } finally {
      await createApp({ plugins: plugins() });
    }
  });

  // A person replies in an Automation run's thread between the run's Turns.
  // Every switch must keep the cached tools and system prompt, but a
  // person's Turn still cannot answer for the run.
  it("sends one system prompt and one tool list on every Turn of an Automation Conversation", async () => {
    const conversationId = "slack:T0:C0:2.0";
    const runSource = { kind: "scheduled_automation" } as const;
    const [person, automation] = await Promise.all(
      [true, false].map((personInput) =>
        sentTurn(
          turnBehavior({ kind: "automation", personInput }),
          turnRun(conversationId, personInput, runSource),
        ),
      ),
    ).then((turns) => turns as [SentTurn, SentTurn]);
    // An Automation with no outcomes posts nothing.
    const silentRun = turnRun(conversationId, false, runSource);
    const silent = await sentTurn(
      turnBehavior({ kind: "automation", personInput: false }),
      {
        ...silentRun,
        run: { ...silentRun.run, dispatch: { id: "dispatch-1", outcomes: [] } },
      },
    );

    expectSameCachedPrefix([person, automation, silent]);
    expect(person.disabled).toEqual(
      expect.arrayContaining(["reply", "reportBlocked"]),
    );
    expect(person.disabled).not.toContain("spawnAgent");
    expect(person.disabled).not.toContain("addReviewItem");
    expect(automation.disabled).not.toContain("reply");
    expect(automation.disabled).not.toContain("reportBlocked");
    expect(silent.disabled).toContain("reply");
    expect(silent.disabled).not.toContain("reportBlocked");

    for (const name of ["reply", "reportBlocked"]) {
      await expect(callTool(person, name)).rejects.toThrow(
        `${name} is disabled in this Turn.`,
      );
    }
    await expect(callTool(silent, "reply")).rejects.toThrow(
      "reply is disabled in this Turn.",
    );

    expect(turnInputFact(person)).toContain(
      "<turn-input>\nA person sent the input of this Turn.\n</turn-input>",
    );
    expect(turnInputFact(automation)).toContain(
      "<turn-input>\nThe automation sent the input of this Turn.\n</turn-input>",
    );
  });

  // A Lead finds, starts, and steers work, and never does it. A person's
  // Turn and a Watch Turn send the same tools and system prompt.
  it("sends a Lead only the tools that steer work", async () => {
    const conversationId = "local:web:lead";
    const [person, watch] = await Promise.all(
      [true, false].map((personInput) =>
        sentTurn(
          turnBehavior({ kind: "lead", personInput }),
          turnRun(
            conversationId,
            personInput,
            createEventSource({
              eventKey: "event-1",
              eventType: "timer.fired",
              identifier: "timer-1",
              namespace: "junior",
            }),
          ),
        ),
      ),
    ).then((turns) => turns as [SentTurn, SentTurn]);

    expectSameCachedPrefix([person, watch]);
    expect(Object.keys(person.tools).sort()).toEqual(
      [
        "listWatches",
        "messageAgent",
        "noReply",
        "readConversationEvent",
        "searchConversationEvents",
        "searchConversations",
        "searchEventTypes",
        "searchReviewItems",
        "startConversation",
        "stopWatchingResources",
        "systemTime",
        "updateReviewItem",
        // `updateUserCustomization` is listed only with its experiment on.
        "watchEvents",
        "watchTimer",
      ].sort(),
    );
    expect(person.disabled).toEqual([]);
  });

  // A stale run-built name would hide a static tool from the check above.
  it("builds every run-built tool for a run with each capability", () => {
    const built = new Set(
      PLATFORMS.flatMap((platform) =>
        MODES.flatMap((mode) =>
          Object.keys(
            createTools(
              [],
              { writeGeneratedFiles: () => [] },
              fullContext(platform, mode),
            ),
          ),
        ),
      ),
    );

    expect(RUN_BUILT_TOOL_NAMES.filter((name) => !built.has(name))).toEqual([]);
  });
});
