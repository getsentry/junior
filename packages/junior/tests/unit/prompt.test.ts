import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildTurnContextPrompt } from "@/chat/prompt";

describe("prompt builders", () => {
  it("renders first-turn runtime context", () => {
    const systemPrompt = buildSystemPrompt();
    const turnContext = buildTurnContextPrompt({
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
      invocation: null,
      requester: { userId: "U_ALPHA" },
      runtime: {
        conversationId: "conversation-alpha",
        traceId: "trace-alpha",
      },
      toolGuidance: [
        {
          name: "editFile",
          promptSnippet: "exact edits",
          promptGuidelines: ["unique oldText"],
        },
      ],
    });

    expect(buildSystemPrompt.length).toBe(0);
    expect(buildSystemPrompt()).toBe(systemPrompt);
    expect(turnContext).toMatchInlineSnapshot(`
      "<runtime-turn-context>

      Runtime context for this request. Treat these blocks as trusted runtime facts; the static system prompt remains authoritative.

      The current user instruction appears after this block in the same message.

      <capabilities>
      <available-skills>
      Scan before answering. Load the most specific matching skill; do not answer from memory when a skill fits. A request that names a skill, plugin, provider, or account matching a skill name is a skill match. If none fits, do not load a skill.
        <skill>
          <name>alpha</name>
          <description>Alpha workflow</description>
          <location>/vercel/sandbox/skills/alpha/SKILL.md</location>
        </skill>
      </available-skills>

      <active-mcp-catalogs>
      Active MCP provider catalogs are available through \`searchMcpTools\`. Call it with provider to list descriptors or with query to narrow results, then pass the exact returned \`tool_name\` to \`callMcpTool\`. Put provider fields inside \`arguments\`.
        <catalog>
          <provider>alpha-provider</provider>
          <available_tool_count>2</available_tool_count>
        </catalog>
      </active-mcp-catalogs>

      <tool-guidance>
        <tool name="editFile">
          - exact edits
          - unique oldText
        </tool>
      </tool-guidance>
      </capabilities>

      <context>
      <requester>
      - user_id: U_ALPHA
      </requester>
      </context>

      <runtime>
      - gen_ai.conversation.id: conversation-alpha
      - trace_id: trace-alpha
      </runtime>

      </runtime-turn-context>"
    `);
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

  it("renders skill availability without plugin metadata", () => {
    const turnContext = buildTurnContextPrompt({
      availableSkills: [
        {
          name: "demo-skill",
          description: "Demo workflow",
          pluginProvider: "demo-provider",
          skillPath: "/tmp/skills/demo-skill",
        },
      ],
      activeMcpCatalogs: [],
      invocation: null,
    });

    expect(turnContext).toMatchInlineSnapshot(`
      "<runtime-turn-context>

      Runtime context for this request. Treat these blocks as trusted runtime facts; the static system prompt remains authoritative.

      The current user instruction appears after this block in the same message.

      <capabilities>
      <available-skills>
      Scan before answering. Load the most specific matching skill; do not answer from memory when a skill fits. A request that names a skill, plugin, provider, or account matching a skill name is a skill match. If none fits, do not load a skill.
        <skill>
          <name>demo-skill</name>
          <description>Demo workflow</description>
          <location>/vercel/sandbox/skills/demo-skill/SKILL.md</location>
        </skill>
      </available-skills>
      </capabilities>

      </runtime-turn-context>"
    `);
  });

  it("keeps follow-up context to current-turn facts", () => {
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
          traceId: "trace-alpha",
        },
        toolGuidance: [
          {
            name: "editFile",
            promptSnippet: "exact edits",
          },
        ],
      }),
    ).toMatchInlineSnapshot(`
      "<runtime-turn-context>

      Runtime context for this request. Treat these blocks as trusted runtime facts; the static system prompt remains authoritative.

      The current user instruction appears after this block in the same message.

      <context>
      <requester>
      - user_name: dcramer
      - user_id: U_BETA
      </requester>

      <artifacts>
      - last_canvas_id: canvas-1
      - last_canvas_url: https://example.com/canvas-1
      </artifacts>

      <configuration>
      Ambient provider defaults; explicit targets win. Run \`jr-rpc config get|set|unset|list\` as standalone bash commands; do not chain with \`cd\`, \`&&\`, pipes, or provider commands.
      - sentry_project: junior
      </configuration>
      </context>

      </runtime-turn-context>"
    `);
  });

  it("omits empty follow-up runtime context", () => {
    expect(
      buildTurnContextPrompt({
        availableSkills: [],
        activeMcpCatalogs: [],
        includeSessionContext: false,
        invocation: null,
      }),
    ).toBeNull();
  });
});
