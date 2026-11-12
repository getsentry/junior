import { describe, expect, it } from "vitest";
import { splitSlackReplyText } from "@/chat/slack/output";
import {
  completedToolCalls,
  slackCallReplies,
  toolCallsOf,
  type ToolCall,
} from "@junior-evals/fixture/results";

// Long enough that Slack delivery splits it into three posts.
const answer = Array.from(
  { length: 200 },
  (_, step) => `${step + 1}. Take a **heap snapshot** and compare it.`,
).join("\n");

function read(texts: string[], text = answer) {
  return slackCallReplies({
    conversationId: "conversation",
    durable: {
      replies: [
        {
          conversationId: "conversation",
          messageId: "message-1",
          text,
        },
      ],
      visibleMessages: [],
    },
    posts: texts.map((text, index) => ({
      channel: "C1",
      text,
      ts: `1.00000${index + 1}`,
    })),
  });
}

describe("slackCallReplies", () => {
  it("reads the posts of one split reply as one reply", () => {
    const posts = splitSlackReplyText(answer);
    expect(posts).toHaveLength(3);

    const { replies, visibleMessages } = read(posts);

    expect(replies).toEqual([
      expect.objectContaining({ messageId: "message-1" }),
    ]);
    expect(visibleMessages).toEqual([]);
  });

  it("reads a split inside a code block as one reply", () => {
    const code = [
      "Run this script:",
      "```ts",
      ...Array.from(
        { length: 200 },
        (_, line) => `console.log("heap step ${line + 1}");`,
      ),
      "```",
    ].join("\n");
    const posts = splitSlackReplyText(code);
    // Delivery closes the block at the end of a post and opens it again in
    // the next post.
    expect(posts.length).toBeGreaterThan(1);
    expect(posts[1]).toMatch(/^```ts\n/);

    const { replies, visibleMessages } = read(posts, code);

    expect(replies).toEqual([
      expect.objectContaining({ messageId: "message-1" }),
    ]);
    expect(visibleMessages).toEqual([]);
  });

  it("keeps the fences of two code blocks split between them", () => {
    const block = (step: number) => [
      "```ts",
      ...Array.from(
        { length: 128 },
        (_, line) => `console.log("step ${step} line ${line + 1}");`,
      ),
      "```",
    ];
    const code = [...block(1), ...block(2)].join("\n");
    const posts = splitSlackReplyText(code);
    // The cut is between the blocks, so each post keeps whole fences.
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatch(/^```ts\nconsole\.log\("step 2 line 1"\)/);

    const { replies, visibleMessages } = read(posts, code);

    expect(replies).toEqual([
      expect.objectContaining({ messageId: "message-1" }),
    ]);
    expect(visibleMessages).toEqual([]);
  });

  it("reads a repeated post of the reply as another reply", () => {
    const { replies, visibleMessages } = read([answer, answer]);

    expect(replies.map((reply) => reply.messageId)).toEqual([
      "message-1",
      "slack:1.000002",
    ]);
    expect(visibleMessages).toEqual([{ content: answer, role: "assistant" }]);
  });
});

describe("toolCallsOf", () => {
  // The result text of the `codemode` tool, as the reporting API returns it.
  const script: ToolCall = {
    input: { code: "..." },
    name: "codemode",
    output: [
      "Script failed (script).",
      "Tool calls (4):",
      "1. stopAgent: ok",
      "2. stopAgent: failed",
      "   No child agent is named scout.",
      "   3. stopAgent: ok",
      "3. stopAgent: rejected by action review",
      "4. stopAgent: not started",
      "Error:",
      "boom",
      "Output:",
      "5. stopAgent: ok",
    ].join("\n"),
    status: "error",
    toolCallId: "call-1",
  };

  it("counts direct, deferred, and script calls of a tool", () => {
    const toolCalls: ToolCall[] = [
      { name: "stopAgent", status: "completed", toolCallId: "call-2" },
      {
        input: { arguments: { to: "scout" }, tool_name: "stopAgent" },
        name: "executeTool",
        status: "completed",
        toolCallId: "call-3",
      },
      script,
    ];

    expect(toolCallsOf("stopAgent", { toolCalls })).toEqual([
      { name: "stopAgent", status: "completed", toolCallId: "call-2" },
      {
        input: { to: "scout" },
        name: "stopAgent",
        status: "completed",
        toolCallId: "call-3",
      },
      { name: "stopAgent", status: "completed", toolCallId: "call-1/1" },
      { name: "stopAgent", status: "error", toolCallId: "call-1/2" },
      { name: "stopAgent", status: "error", toolCallId: "call-1/3" },
    ]);
    expect(
      completedToolCalls("stopAgent", { toolCalls: [script] }),
    ).toHaveLength(1);
  });

  it("reads no script calls from a script without calls", () => {
    const toolCalls: ToolCall[] = [
      {
        ...script,
        output: "Script completed.\nOutput:\nTool calls (1):\n1. stopAgent: ok",
      },
    ];

    expect(toolCallsOf("stopAgent", { toolCalls })).toEqual([]);
  });
});
