import { describe, expect, it } from "vitest";
import { splitSlackReplyText } from "@/chat/slack/output";
import { slackCallReplies } from "@junior-evals/fixture/results";

// Long enough that Slack delivery splits it into three posts.
const answer = Array.from(
  { length: 100 },
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
        { length: 120 },
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

  it("reads a repeated post of the reply as another reply", () => {
    const { replies, visibleMessages } = read([answer, answer]);

    expect(replies.map((reply) => reply.messageId)).toEqual([
      "message-1",
      "slack:1.000002",
    ]);
    expect(visibleMessages).toEqual([{ content: answer, role: "assistant" }]);
  });
});
