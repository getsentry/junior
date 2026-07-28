import { describe, expect, it } from "vitest";
import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { buildSystemPrompt, buildTurnContextPrompt } from "@/chat/prompt";

describe("prompt builders", () => {
  it("returns a byte-stable static system prompt", () => {
    const source = createSlackSource({
      teamId: "T123",
      channelId: "C123",

      type: "priv",
    });
    const systemPrompt = buildSystemPrompt({ source });

    expect(buildSystemPrompt({ source })).toBe(systemPrompt);
  });

  it("puts concise Slack output guidance last without exposing delivery ceilings", () => {
    const systemPrompt = buildSystemPrompt({
      source: createSlackSource({
        teamId: "T123",
        channelId: "C123",
        type: "priv",
      }),
    });

    const outputIndex = systemPrompt.indexOf(
      '<output format="slack-markdown">',
    );
    expect(outputIndex).toBeGreaterThan(
      systemPrompt.indexOf("</failure-handling>"),
    );
    expect(systemPrompt.slice(outputIndex)).toContain(
      "Default to the shortest complete reply—usually 1–5 sentences and under 800 characters.",
    );
    expect(systemPrompt).not.toContain("max_inline_chars");
    expect(systemPrompt).not.toContain("max_inline_lines");
    expect(systemPrompt.endsWith("</output>")).toBe(true);
  });

  it("tells Slack agents to use the no-reply marker for silent completion", () => {
    const systemPrompt = buildSystemPrompt({
      source: createSlackSource({
        teamId: "T123",
        channelId: "C123",
        type: "priv",
      }),
    });

    expect(systemPrompt).toContain(
      `When no visible thread reply is requested or useful, keep tool-calling messages text-free and make the final message exactly ${NO_REPLY_MARKER}.`,
    );
    expect(systemPrompt).not.toContain(
      "Side-effect-only completion for addReaction",
    );
    expect(systemPrompt).not.toContain("side-effect-only completion");
  });

  it("returns a byte-stable local system prompt variant", () => {
    const source = createLocalSource("local:test:run-test");
    const systemPrompt = buildSystemPrompt({ source });

    expect(buildSystemPrompt({ source })).toBe(systemPrompt);
    expect(systemPrompt).not.toBe(
      buildSystemPrompt({
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",

          type: "priv",
        }),
      }),
    );
  });

  it("requires safe mutation recovery and concise file-change reporting", () => {
    const systemPrompt = buildSystemPrompt({
      source: createLocalSource("local:test:prompt-contracts"),
    });

    expect(systemPrompt).toContain(
      "inspect authoritative state before retrying",
    );
    expect(systemPrompt).toContain("do not repeat the mutation");
    expect(systemPrompt).toContain("name the changed paths");
    expect(systemPrompt).toContain(
      "only when it offers a profile that better matches the task",
    );
    expect(systemPrompt).toContain("Skip short lookups and routine commands");
  });

  it("renders sandbox workspace root as runtime context", () => {
    const prompt = buildTurnContextPrompt({
      availableSkills: [],
      activeMcpCatalogs: [],
    });

    expect(prompt).toContain("- sandbox.workspace_root: /vercel/sandbox");
  });

  it("renders Slack conversation facts in runtime context", () => {
    const prompt = buildTurnContextPrompt({
      availableSkills: [],
      activeMcpCatalogs: [],
      runtime: {
        conversationId: "slack:C123:1712345.000001",
        slackConversation: {
          type: "private_channel",
          name: "#roadmap & launches",
        },
      },
    });

    expect(prompt).toContain(
      "- gen_ai.conversation.id: slack:C123:1712345.000001",
    );
    expect(prompt).toContain("- slack.conversation.type: private_channel");
    expect(prompt).toContain(
      "- slack.conversation.name: #roadmap &amp; launches",
    );
    expect(prompt).not.toContain("#roadmap & launches");
  });

  it("renders generic dispatch facts in runtime context", () => {
    const prompt = buildTurnContextPrompt({
      availableSkills: [],
      activeMcpCatalogs: [],
      dispatch: {
        actor: { platform: "system", name: "scheduler" },
        plugin: "scheduler",
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",

          type: "priv",
        }),
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        metadata: {
          scheduledFor: "2026-05-26T12:00:00.000Z",
          taskId: "sched_plugin_1",
        },
      },
    });

    expect(prompt).toContain("<dispatch>");
    expect(prompt).toContain(
      "- dispatch.execution: execute the dispatched input now",
    );
    expect(prompt).toContain(
      "- dispatch.delivery: the runtime delivers the final answer to the destination",
    );
    expect(prompt).toContain("- dispatch.actor.platform: system");
    expect(prompt).toContain("- dispatch.actor.name: scheduler");
    expect(prompt).toContain("- source.platform: slack");
    expect(prompt).toContain("- destination.channel_id: C123");
    expect(prompt).toContain(
      "- dispatch.metadata.scheduledFor: 2026-05-26T12:00:00.000Z",
    );
    expect(prompt).toContain("- dispatch.metadata.taskId: sched_plugin_1");
  });

  it("omits follow-up runtime context once session bootstrap exists", () => {
    expect(
      buildTurnContextPrompt({
        availableSkills: [
          {
            name: "alpha",
            description: "Alpha workflow",
            skillPath: "/tmp/skills/alpha",
          },
        ],
        activeMcpCatalogs: [
          { provider: "alpha-provider", available_tool_count: 2 },
        ],
        artifactState: {
          listColumnMap: {},
          lastCanvasId: "canvas-1",
          lastCanvasUrl: "https://example.com/canvas-1",
        },
        configuration: {
          sentry_project: "junior",
        },
        includeSessionContext: false,
        actor: {
          userId: "U0BETA",
          userName: "dcramer",
        },
        runtime: {
          conversationId: "conversation-alpha",
        },
        toolGuidance: [
          {
            name: "editFile",
            promptSnippet: "exact edits",
          },
        ],
      }),
    ).toBeNull();
  });

  it("renders plugin prompt contributions without replaying follow-up bootstrap context", () => {
    const prompt = buildTurnContextPrompt({
      availableSkills: [
        {
          name: "alpha",
          description: "Alpha workflow",
          skillPath: "/tmp/skills/alpha",
        },
      ],
      activeMcpCatalogs: [
        { provider: "alpha-provider", available_tool_count: 2 },
      ],
      includeSessionContext: false,
      pluginPromptContributions: [
        {
          id: "memory",
          pluginName: "memory",
          text: "User prefers concise answers.",
        },
      ],
      runtime: {
        conversationId: "conversation-alpha",
      },
    });

    expect(prompt).toContain("User prefers concise answers.");
    expect(prompt).toContain('plugin="memory"');
    expect(prompt).not.toContain("<available-skills>");
    expect(prompt).not.toContain("conversation-alpha");
  });
});
