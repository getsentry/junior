import { describe, expect, it } from "vitest";
import type { AssistantReply } from "@/chat/services/turn-result";
import type { SlackRenderIntent } from "@/chat/slack/render/intents";
import { planSlackReplyPosts } from "@/chat/slack/reply";

function baseReply(overrides: Partial<AssistantReply> = {}): AssistantReply {
  return {
    text: "plain fallback text",
    diagnostics: {
      outcome: "success",
      modelId: "test-model",
      assistantMessageCount: 1,
      toolCalls: [],
      toolResultCount: 0,
      toolErrorCount: 0,
      usedPrimaryText: true,
    },
    ...overrides,
  };
}

describe("planSlackReplyPosts with a render intent", () => {
  it("emits a single blocks+fallback post for a summary_card intent", () => {
    const intent: SlackRenderIntent = {
      kind: "summary_card",
      title: "PR #42 — fix retry storm",
      subtitle: "dcramer/acme",
      fields: [
        { label: "Status", value: "Open" },
        { label: "Reviewer", value: "alberto" },
      ],
      actions: [
        { label: "View PR", url: "https://github.com/dcramer/acme/pull/42" },
      ],
    };

    const posts = planSlackReplyPosts({ reply: baseReply({ intent }) });

    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.stage).toBe("thread_reply");
    expect(post.blocks).toBeDefined();
    // A section body and an actions block — exercise the structural
    // shape without over-fitting the renderer's internal choices.
    expect(post.blocks!.length).toBeGreaterThanOrEqual(2);
    expect(post.blocks![0]).toMatchObject({ type: "section" });
    expect(post.blocks!.some((b) => b.type === "actions")).toBe(true);
    // Fallback text is non-empty and derived from the intent, not the
    // stale plain text on AssistantReply.
    expect(post.text.trim().length).toBeGreaterThan(0);
    expect(post.text).toContain("PR #42");
    expect(post.text).not.toBe("plain fallback text");
  });

  it("falls through to the plain text path for a plain_reply intent", () => {
    const intent: SlackRenderIntent = {
      kind: "plain_reply",
      text: "Sure — will follow up tomorrow.",
    };

    const posts = planSlackReplyPosts({
      reply: baseReply({ text: "Sure — will follow up tomorrow.", intent }),
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.blocks).toBeUndefined();
    expect(posts[0]!.text).toBe("Sure — will follow up tomorrow.");
  });

  it("ignores the intent when the reply must not post visible text", () => {
    const intent: SlackRenderIntent = {
      kind: "summary_card",
      title: "Should not render",
    };

    const posts = planSlackReplyPosts({
      reply: baseReply({
        intent,
        deliveryPlan: {
          mode: "channel_only",
          postThreadText: false,
          attachFiles: "none",
        },
      }),
    });

    expect(posts).toHaveLength(0);
  });

  it("falls back to the plain text path when no intent is captured", () => {
    const posts = planSlackReplyPosts({
      reply: baseReply({ text: "ordinary mrkdwn reply" }),
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.blocks).toBeUndefined();
    expect(posts[0]!.text).toBe("ordinary mrkdwn reply");
  });
});
