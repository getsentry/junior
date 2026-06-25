import { describe, expect, it } from "vitest";
import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import { buildSystemPrompt, buildTurnContextPrompt } from "@/chat/prompt";

describe("prompt builders", () => {
  it("returns a byte-stable static system prompt", () => {
    const source = createSlackSource({
      teamId: "T123",
      channelId: "C123",
      channelType: "channel",
    });
    const systemPrompt = buildSystemPrompt({ source });

    expect(buildSystemPrompt({ source })).toBe(systemPrompt);
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
          channelType: "channel",
        }),
      }),
    );
  });

  it("omits empty runtime context sections", () => {
    expect(
      buildTurnContextPrompt({
        availableSkills: [],
        activeMcpCatalogs: [],
        invocation: null,
      }),
    ).toBeNull();
  });

  it("renders Slack conversation facts in runtime context", () => {
    const prompt = buildTurnContextPrompt({
      availableSkills: [],
      activeMcpCatalogs: [],
      invocation: null,
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
        actor: { type: "system", id: "scheduler" },
        plugin: "scheduler",
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",
          channelType: "channel",
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
      invocation: null,
    });

    expect(prompt).toContain("<dispatch>");
    expect(prompt).toContain(
      "- dispatch.execution: execute the dispatched input now",
    );
    expect(prompt).toContain(
      "- dispatch.delivery: the runtime delivers the final answer to the destination",
    );
    expect(prompt).toContain("- dispatch.actor.type: system");
    expect(prompt).toContain("- dispatch.actor.id: scheduler");
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
        invocation: null,
        requester: {
          userId: "U_BETA",
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
      invocation: null,
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
