import { describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createResumeState } from "@/chat/agent/resume";
import { CODEMODE_TOOL_NAME } from "@/chat/codemode/result";
import { createToolActionReview } from "@/chat/guardian/gate";
import { restoreToolActionRejections } from "@/chat/guardian/history";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";
import type { PiMessage } from "@/chat/pi/messages";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { createTools } from "@/chat/tools";
import { tool, type AnyToolDefinition } from "@/chat/tools/definition";
import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";

const ROOT_TURN_TOOLS = turnBehavior({
  kind: "root",
  personInput: true,
}).tools;

const CONVERSATION_ID = "local:test:codemode-tool";
const DESTINATION = {
  platform: "local",
  conversationId: CONVERSATION_ID,
} as const;
const SOURCE = createLocalSource(CONVERSATION_ID);
const CODEMODE_CALL_ID = "call-codemode";

/** Guardian's model review is the only faked edge. It denies every post. */
const denyPosts = vi.fn<ToolActionReviewer["review"]>(async () => ({
  decision: "deny",
  reason: "The user did not ask for a post.",
  riskLevel: "high",
  rule: "unrequested_write",
  userAuthorization: "low",
}));

/** A reviewed write that never runs, because Guardian denies it. */
const post = tool({
  annotations: {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
  },
  approvalMode: "review",
  describeProgress: () => "Posting a message",
  description: "Post a message to a channel.",
  inputSchema: Type.Object({ channel: Type.String(), text: Type.String() }),
  execute: async () => ({ posted: true }),
}) as AnyToolDefinition;

describe("codemode tool", () => {
  it("runs the script's calls through the Run's pipeline and keeps the script result in details", async () => {
    const registry = createTools([], {}, {
      conversationId: CONVERSATION_ID,
      destination: DESTINATION,
      egress: {
        async fetch() {
          return new Response("ok");
        },
      },
      source: SOURCE,
      turnTools: ROOT_TURN_TOOLS,
      workspace: {} as never,
    } as never);
    const resume = createResumeState({
      checkpoint: { resumed: false, sliceId: 1 },
      conversationId: CONVERSATION_ID,
      destination: DESTINATION,
      durability: {},
      recordActiveMcpProviders: async () => undefined,
      runSource: SOURCE,
      startedAtMs: Date.now(),
      surface: "internal",
      turnId: "turn-codemode",
    });
    const started: string[] = [];
    const statuses: unknown[] = [];
    const systemTime = {
      ...registry.systemTime,
      describeProgress: () => "Checking the time",
    } as AnyToolDefinition;
    const agentTools = createPiAgentTools(
      { ...registry, post, systemTime } as Record<string, AnyToolDefinition>,
      new SkillSandbox([], []),
      {
        spanContext: {},
        searchToolsCost: { owner: "none" },
        onStatus: async (status) => {
          statuses.push(status);
        },
        onToolCall: (_id, toolName) => {
          started.push(toolName);
        },
        conversationPrivacy: "private",
        actionReview: createToolActionReview({
          context: {
            actor: { platform: "local", userId: "local-user" },
            conversationId: CONVERSATION_ID,
            destination: DESTINATION,
            source: SOURCE,
            userIntent: () => "What time is it, and what am I watching?",
          },
          onDecision: async () => undefined,
          onFatal: () => undefined,
          reviewer: { review: denyPosts },
        }),
        codeMode: { countToolCall: resume.countToolCall },
      },
    );
    const codemode = agentTools.find(
      (candidate) => candidate.name === CODEMODE_TOOL_NAME,
    );
    if (!codemode) {
      throw new Error("codemode was not registered");
    }
    // `<script-tools>` lists the tools, so another tool set keeps the same
    // tool definition and the provider prompt cache.
    expect(
      createPiAgentTools(
        registry as Record<string, AnyToolDefinition>,
        new SkillSandbox([], []),
        {
          spanContext: {},
          searchToolsCost: { owner: "none" },
          conversationPrivacy: "private",
          codeMode: { countToolCall: resume.countToolCall },
        },
      ).find((candidate) => candidate.name === CODEMODE_TOOL_NAME)?.description,
    ).toBe(codemode.description);

    const result = (await codemode.execute(CODEMODE_CALL_ID, {
      code: `
        const [time, watches] = await Promise.all([
          tools.systemTime({}),
          tools.listWatches({}),
        ]);
        text("watches: " + watches.subscriptions.length);
        await tools.post({ channel: "#team", text: "done" }).catch(() => {});
        await tools
          .executeTool({ tool_name: "systemTime", arguments: {} })
          .catch(() => {});
        return { hasTime: typeof time.unix_ms === "number" };
      `,
    })) as AgentToolResult<unknown>;

    // Each nested call takes the normal path, so its hooks run. The
    // redirected executeTool call never runs.
    expect(started).toEqual([
      CODEMODE_TOOL_NAME,
      "systemTime",
      "listWatches",
      "post",
    ]);
    // Nested calls show their progress labels, except the rejected post.
    expect(statuses).toEqual([{ text: "Checking the time", source: "tool" }]);
    // The 3 nested calls that ran count toward the Turn's tool-call total.
    expect(resume.countToolCall()).toBe(4);
    expect(result.details).toMatchObject({
      ok: true,
      value: { hasTime: true },
      output: "watches: 0",
      calls: [
        { id: `${CODEMODE_CALL_ID}/c1`, toolName: "systemTime", status: "ok" },
        { id: `${CODEMODE_CALL_ID}/c2`, toolName: "listWatches", status: "ok" },
        { id: `${CODEMODE_CALL_ID}/c3`, toolName: "post", status: "rejected" },
        {
          id: `${CODEMODE_CALL_ID}/c4`,
          toolName: "executeTool",
          status: "error",
        },
      ],
    });
    const [content] = result.content as Array<{ text: string }>;
    expect(content!.text).toMatchInlineSnapshot(`
      "Script completed.
      Tool calls (4):
      1. systemTime: ok
      2. listWatches: ok
      3. post: rejected by action review
         This action was rejected due to unacceptable risk.
         The agent must not attempt the same outcome through a workaround, indirect execution, or policy circumvention.
         If the reason is missing or withheld authorization and exact confirmation could make the action allowable, ask for that confirmation now, the way your instructions say to ask. Name the exact action, target, and material side effects.
         Proceed only with a materially safer alternative. Otherwise, explain the specific risk the way your instructions say to report, without mentioning Guardian or internal review mechanics.
         Reason: The user did not ask for a post.
      4. executeTool: failed
         executeTool does not run in a script. Call tools.systemTime(arguments) directly, with only the object from the executeTool arguments field.
      Action review rejected 1 of these calls. Follow the instructions of each rejected call.
      Output:
      watches: 0
      Return value:
      {"hasTime":true}"
    `);

    // History restores the rejection from the details of the stored result.
    const history: PiMessage[] = [
      {
        role: "toolResult",
        toolCallId: CODEMODE_CALL_ID,
        toolName: CODEMODE_TOOL_NAME,
        content: result.content,
        details: result.details,
        isError: false,
        timestamp: 1,
      } as PiMessage,
    ];
    expect(restoreToolActionRejections(history)).toEqual([
      expect.objectContaining({
        decision: "deny",
        input: { channel: "#team", text: "done" },
        tool: expect.objectContaining({ name: "post" }),
      }),
    ]);
  });
});
