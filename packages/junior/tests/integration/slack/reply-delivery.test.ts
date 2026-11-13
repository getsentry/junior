import { githubPlugin } from "@sentry/junior-github";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb, getSqlExecutor } from "@/chat/db";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { sendSlackReply } from "@/chat/slack/reply";
import {
  type CapturedSlackApiCall,
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

function markdownBody(call: CapturedSlackApiCall): string {
  const [block] = call.params.blocks as Array<{ type: string; text: string }>;
  expect(block?.type).toBe("markdown");
  return block?.text ?? "";
}

describe("sendSlackReply", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
    resetSlackApiMockState();
  });

  afterEach(async () => {
    resetSlackApiMockState();
    await closeDb();
  });

  it("posts text with compact attribution in the conversation footer", async () => {
    const messageTs = await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      replyAttribution: {
        label: "Automation",
        detail: "Water reminder",
      },
      text: "hello",
      threadTs: "1700000000.000100",
    });

    expect(messageTs).toHaveLength(1);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.000100",
          text: "hello\n\nAutomation · Water reminder",
          blocks: [
            {
              type: "markdown",
              text: "hello",
            },
            {
              type: "context",
              elements: [
                {
                  type: "plain_text",
                  text: "Automation · Water reminder",
                },
                {
                  type: "mrkdwn",
                  text: "*ID:* slack:C123:1700000000.000100",
                },
              ],
            },
          ],
        }),
      }),
    ]);
  });

  it("posts a markdown table with contiguous rows", async () => {
    await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      text: [
        "7 rows were billed twice:",
        "| Org | Billed |",
        "|---|---|",
        "| 405346 | $89.34 |",
        "| 4512136079409152 | $34.32 |",
        "What this means",
      ].join("\n"),
      threadTs: "1700000000.000100",
    });

    const [post] = getCapturedSlackApiCalls("chat.postMessage");
    expect(post && markdownBody(post)).toBe(
      [
        "7 rows were billed twice:",
        "",
        "| Org | Billed |",
        "|---|---|",
        "| 405346 | $89.34 |",
        "| 4512136079409152 | $34.32 |",
        "",
        "What this means",
      ].join("\n"),
    );
  });

  it("starts every chunked post of a table with its header rows", async () => {
    const header = "| Shard | Tests | Time |\n|---|---|---|";
    const rows = Array.from(
      { length: 120 },
      (_, i) => `| shard-${i} | ${1800 + i} tests | ${300 + i}s |`,
    );
    await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      text: ["x".repeat(3_000), header, ...rows].join("\n"),
      threadTs: "1700000000.000100",
    });

    const posts =
      getCapturedSlackApiCalls("chat.postMessage").map(markdownBody);
    expect(posts.some((text) => text.endsWith("|---|---|---|"))).toBe(false);
    const tables = posts.filter((text) => text.includes("| shard-"));
    expect(tables.length).toBeGreaterThan(1);
    for (const text of tables) {
      expect(text.startsWith(`${header}\n`)).toBe(true);
      expect(text).not.toMatch(/\|\n\n\|/);
    }
    expect(tables.join("\n").match(/\| shard-/g)).toHaveLength(rows.length);
  });

  it("keeps two tables apart when a post ends between them", async () => {
    const first = "| A | B |\n|---|---|\n| a1 | b1 |";
    const second = `| ${"C".repeat(200)} | D |\n|---|---|\n| c1 | d1 |`;
    // The 4,000-character budget ends inside the second table's header row,
    // so the post splits at the blank line between the tables.
    const prose = "x".repeat(3_900 - 2 - first.length);
    await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      text: `${prose}\n\n${first}\n\n${second}`,
      threadTs: "1700000000.000100",
    });

    const posts =
      getCapturedSlackApiCalls("chat.postMessage").map(markdownBody);
    expect(posts).toEqual([`${prose}\n\n${first}`, second]);
  });

  it("returns every posted message timestamp for chunked replies", async () => {
    const messageTs = await sendSlackReply({
      channelId: "C123",
      conversationId: "agent-dispatch:dispatch-1",
      text: "a".repeat(9_000),
    });

    expect(messageTs).toHaveLength(3);
    expect(messageTs.every(Boolean)).toBe(true);

    const posts = getCapturedSlackApiCalls("chat.postMessage");
    expect(posts).toHaveLength(3);
    expect(posts[0]?.params).toEqual(
      expect.objectContaining({
        channel: "C123",
      }),
    );
    expect(posts[0]?.params).not.toHaveProperty("thread_ts");
    // Later chunks reply under the first posted message.
    expect(posts[1]?.params).toEqual(
      expect.objectContaining({
        channel: "C123",
        thread_ts: messageTs[0],
      }),
    );
    expect(posts[2]?.params).toEqual(
      expect.objectContaining({
        channel: "C123",
        thread_ts: messageTs[0],
      }),
    );
  });

  it("keeps the original thread for every chunk", async () => {
    const messageTs = await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      text: "a".repeat(9_000),
      threadTs: "1700000000.000100",
    });

    expect(messageTs.length).toBeGreaterThan(1);
    for (const post of getCapturedSlackApiCalls("chat.postMessage")) {
      expect(post.params).toEqual(
        expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.000100",
        }),
      );
    }
  });

  it("escapes attribution in mrkdwn fallback text", async () => {
    await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      replyAttribution: {
        label: "Scheduled <@U123>",
        detail: "Weekly & <https://example.com>",
      },
      text: "hello",
      threadTs: "1700000000.000100",
    });

    expect(
      getCapturedSlackApiCalls("chat.postMessage")[0]?.params,
    ).toMatchObject({
      text: "hello\n\nScheduled &lt;@U123&gt; · Weekly &amp; &lt;https://example.com&gt;",
      blocks: [
        {
          type: "markdown",
          text: "hello",
        },
        {
          type: "context",
          elements: expect.arrayContaining([
            {
              type: "plain_text",
              text: "Scheduled <@U123> · Weekly & <https://example.com>",
            },
          ]),
        },
      ],
    });
  });

  it("keeps object groups in one thread and uses text without a URL", async () => {
    const card = {
      kind: "automation" as const,
      id: "sched_reminder",
      title: "Reminder <@U123>",
      url: "https://junior.example.com/automations/sched_reminder",
      trigger: "Every Monday",
      instruction: "Full instructions stay off the preview.",
      warning: null,
    };
    const timestamps = await sendSlackReply({
      channelId: "C123",
      conversationId: "local:cards",
      text: "",
      cards: [
        ...Array.from({ length: 5 }, (_, index) => ({
          ...card,
          id: `sched_${index}`,
          url: `https://junior.example.com/automations/sched_${index}`,
        })),
        { ...card, id: "sched_no_url", url: null },
      ],
    });
    const posts = getCapturedSlackApiCalls("chat.postMessage");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.params).not.toHaveProperty("thread_ts");
    expect(posts[1]?.params).toMatchObject({ thread_ts: timestamps[0] });
    expect(posts[1]?.params.blocks).toContainEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Automation\nReminder &lt;@U123&gt;\nEvery Monday",
      },
    });
    expect(posts[1]?.params).not.toHaveProperty("metadata");
    expect(posts[1]?.params.text).toBe(
      "Automation\nReminder &lt;@U123&gt;\nEvery Monday",
    );
    for (const post of posts) {
      expect(JSON.stringify(post.params)).not.toContain(card.instruction);
    }
  });

  it("does not post empty text", async () => {
    await expect(
      sendSlackReply({
        channelId: "C123",
        conversationId: "slack:C123:1700000000.000100",
        text: "   ",
        threadTs: "1700000000.000100",
      }),
    ).resolves.toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });

  it("formats plugin references with the Location config and known people", async () => {
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const slack = await upsertIdentity(getSqlExecutor(), {
      kind: "user",
      provider: "slack",
      providerTenantId: "T123",
      providerSubjectId: "U123",
      email: "requester@example.com",
      emailVerified: true,
    });
    await upsertLinkedIdentity(getSqlExecutor(), slack.userId!, {
      kind: "user",
      provider: "github",
      providerSubjectId: "gh-requester",
      handle: "Requester",
    });

    await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      formatting: {
        configuration: { "github.repo": "getsentry/junior" },
        teamId: "T123",
      },
      text: "@requester fixed #12. Thanks @octocat.",
      threadTs: "1700000000.000100",
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          text: "<@U123> fixed [#12](https://github.com/getsentry/junior/issues/12). Thanks @octocat.",
        }),
      }),
    ]);

    // A bare Slack user ID stays a Slack mention, not a GitHub login.
    resetSlackApiMockState();
    await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      formatting: { teamId: "T123" },
      text: "@U012ABCDEF reviewed getsentry/junior#13 with @octocat.",
      threadTs: "1700000000.000100",
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          text: "<@U012ABCDEF> reviewed [getsentry/junior#13](https://github.com/getsentry/junior/issues/13) with [@octocat](https://github.com/octocat).",
        }),
      }),
    ]);
  });
});
