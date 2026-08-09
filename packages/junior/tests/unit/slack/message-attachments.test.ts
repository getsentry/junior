import { describe, expect, it } from "vitest";
import { renderAttachmentText } from "@/chat/slack/message/attachments";

describe("renderAttachmentText", () => {
  it("returns empty string for invalid payloads", () => {
    expect(renderAttachmentText(undefined)).toBe("");
    expect(renderAttachmentText(null)).toBe("");
    expect(renderAttachmentText("string")).toBe("");
    expect(renderAttachmentText(42)).toBe("");
  });

  it("renders text-bearing fields and drops noise", () => {
    const raw = [
      {
        fallback: "Deploy failed",
        color: "#ff0000",
        title: "Production deploy",
        title_link: "https://example.com/deploy/123",
        text: "OOM on pod-42",
        fields: [
          { title: "Status", value: "Failed", short: true },
          { title: "Owner", value: "Platform" },
        ],
        footer: "Datadog Monitor",
        callback_id: "should_be_dropped",
        actions: [{ text: "Ack", type: "button" }],
        image_url: "https://example.com/chart.png",
      },
    ];

    const text = renderAttachmentText(raw);
    expect(text).toBe(
      [
        "[attachment] Production deploy (https://example.com/deploy/123)",
        "OOM on pod-42",
        "Status: Failed",
        "Owner: Platform",
        "Datadog Monitor",
      ].join("\n"),
    );
    expect(text).not.toContain("should_be_dropped");
    expect(text).not.toContain("Ack");
    expect(text).not.toContain("chart.png");
  });

  it("skips attachments with no text content", () => {
    const raw = [{ color: "#36a64f" }, { fallback: "real content" }];
    expect(renderAttachmentText(raw)).toBe("[attachment] real content");
  });

  it("caps at 10 attachments", () => {
    const raw = Array.from({ length: 15 }, (_, i) => ({
      fallback: `item-${i}`,
    }));
    const text = renderAttachmentText(raw);
    expect(text).toContain("item-9");
    expect(text).not.toContain("item-10");
  });

  it("renders attachment with rich fields without fallback noise", () => {
    const raw = [
      {
        fallback: "Deploy failed on prod",
        title: "Production deploy",
        title_link: "https://example.com/deploy",
        text: "OOM on pod-42",
        fields: [{ title: "Status", value: "Failed" }],
        footer: "Datadog",
      },
    ];
    const text = renderAttachmentText(raw);
    expect(text).toBe(
      [
        "[attachment] Production deploy (https://example.com/deploy)",
        "OOM on pod-42",
        "Status: Failed",
        "Datadog",
      ].join("\n"),
    );
    expect(text).not.toContain("Deploy failed on prod");
  });

  it("uses nested Block Kit content instead of the attachment fallback", () => {
    const text = renderAttachmentText([
      {
        fallback: "[no preview available]",
        blocks: [
          {
            type: "section",
            text: { type: "plain_text", text: "Taylor Example" },
          },
        ],
      },
    ]);

    expect(text).toBe("[attachment] Taylor Example");
    expect(text).not.toContain("[no preview available]");
  });

  it("preserves multi-line attachment bodies and restores collapsed lists", () => {
    const text = renderAttachmentText([
      {
        author_name: "Junior",
        text: "**vitest-evals 0.16.0** is out.  - **bump:** `0.15.0` → `0.16.0` (stable minor) - **prep:** <https://example.com/a> - **publish issue:** <https://example.com/b>",
        footer: "Thread in Slack Conversation",
      },
    ]);

    expect(text).toBe(
      [
        "[attachment] Junior",
        "**vitest-evals 0.16.0** is out.",
        "- **bump:** `0.15.0` → `0.16.0` (stable minor)",
        "- **prep:** <https://example.com/a>",
        "- **publish issue:** <https://example.com/b>",
        "Thread in Slack Conversation",
      ].join("\n"),
    );
  });

  it("deduplicates bare title text when rendering linked titles", () => {
    const text = renderAttachmentText([
      {
        title: "Production deploy",
        title_link: "https://example.com/deploy",
        text: "Production deploy",
      },
    ]);

    expect(text).toBe(
      "[attachment] Production deploy (https://example.com/deploy)",
    );
  });

  it("uses fallback when no rich content exists", () => {
    const raw = [{ fallback: "Alert: CPU usage high" }];
    const text = renderAttachmentText(raw);
    expect(text).toBe("[attachment] Alert: CPU usage high");
  });

  it("returns empty string for no attachments", () => {
    expect(renderAttachmentText(undefined)).toBe("");
    expect(renderAttachmentText([])).toBe("");
  });

  it("accepts raw Slack message payloads", () => {
    const rawMessage = {
      attachments: [{ fallback: "Alert: disk usage high" }],
    };
    expect(renderAttachmentText(rawMessage)).toBe(
      "[attachment] Alert: disk usage high",
    );
  });
});
