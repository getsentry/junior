import { describe, expect, it } from "vitest";
import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import { buildSystemPrompt, buildTurnContextPrompt } from "@/chat/prompt";

describe("prompt builders", () => {
  it("keeps direct instructions above AGENTS.md instructions", () => {
    expect(
      buildSystemPrompt({ source: createLocalSource("local:test") }),
    ).toContain(
      "Direct system/developer/user instructions (as part of a prompt) take precedence over AGENTS.md instructions.",
    );
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

          visibility: "private",
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
