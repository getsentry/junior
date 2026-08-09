import { describe, expect, it } from "vitest";
import {
  renderSlackLegacyAttachmentText,
  appendSlackLegacyAttachmentText,
} from "@/chat/slack/legacy-attachments";

describe("renderSlackLegacyAttachmentText", () => {
  it("returns empty string for invalid payloads", () => {
    expect(renderSlackLegacyAttachmentText(undefined)).toBe("");
    expect(renderSlackLegacyAttachmentText(null)).toBe("");
    expect(renderSlackLegacyAttachmentText("string")).toBe("");
    expect(renderSlackLegacyAttachmentText(42)).toBe("");
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

    const text = renderSlackLegacyAttachmentText(raw);
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
    expect(renderSlackLegacyAttachmentText(raw)).toBe(
      "[attachment] real content",
    );
  });

  it("caps at 10 attachments", () => {
    const raw = Array.from({ length: 15 }, (_, i) => ({
      fallback: `item-${i}`,
    }));
    const text = renderSlackLegacyAttachmentText(raw);
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
    const text = renderSlackLegacyAttachmentText(raw);
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

  it("renders Block Kit content nested inside an attachment", () => {
    const text = renderSlackLegacyAttachmentText([
      {
        fallback: "[no preview available]",
        blocks: [
          {
            type: "section",
            text: { type: "plain_text", text: "Taylor Example" },
          },
          {
            type: "context",
            elements: [
              {
                type: "image",
                image_url: "https://example.com/full-star.png",
                alt_text: "full star",
              },
              {
                type: "image",
                image_url: "https://example.com/empty-star.png",
                alt_text: "empty star",
              },
            ],
          },
          {
            type: "section",
            text: { type: "plain_text", text: "The app never loaded" },
          },
          {
            type: "context",
            elements: [
              {
                type: "image",
                image_url: "https://example.com/play-store.png",
                alt_text: "Play Store",
              },
              {
                type: "mrkdwn",
                text: "Play Store • v.3.2.13",
              },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "static_select",
                placeholder: { type: "plain_text", text: "Translate to" },
                options: [
                  {
                    text: { type: "plain_text", text: "English" },
                    value: "en-US",
                  },
                ],
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Read full review" },
                url: "https://example.com/review/123",
                value: "private-action-value",
              },
            ],
          },
        ],
      },
    ]);

    expect(text).toBe(
      [
        "[attachment] Taylor Example",
        "full star",
        "empty star",
        "The app never loaded",
        "Play Store",
        "Play Store • v.3.2.13",
        "Translate to",
        "Read full review (https://example.com/review/123)",
      ].join("\n"),
    );
    expect(text).not.toContain("[no preview available]");
    expect(text).not.toContain("private-action-value");
    expect(text).not.toContain("English");
  });

  it("preserves multi-line attachment bodies and restores collapsed lists", () => {
    const text = renderSlackLegacyAttachmentText([
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
    const text = renderSlackLegacyAttachmentText([
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
    const text = renderSlackLegacyAttachmentText(raw);
    expect(text).toBe("[attachment] Alert: CPU usage high");
  });

  it("returns empty string for no attachments", () => {
    expect(renderSlackLegacyAttachmentText(undefined)).toBe("");
    expect(renderSlackLegacyAttachmentText([])).toBe("");
  });

  it("accepts raw Slack message payloads", () => {
    const rawMessage = {
      attachments: [{ fallback: "Alert: disk usage high" }],
    };
    expect(renderSlackLegacyAttachmentText(rawMessage)).toBe(
      "[attachment] Alert: disk usage high",
    );
  });
});

describe("appendSlackLegacyAttachmentText", () => {
  it("returns base text when no attachments", () => {
    expect(appendSlackLegacyAttachmentText("hello", undefined)).toBe("hello");
    expect(appendSlackLegacyAttachmentText("hello", [])).toBe("hello");
  });

  it("returns attachment text when base is empty", () => {
    const raw = { attachments: [{ fallback: "Alert fired" }] };
    const result = appendSlackLegacyAttachmentText("", raw);
    expect(result).toBe("[attachment] Alert fired");
  });

  it("combines base text and attachment text", () => {
    const raw = { attachments: [{ fallback: "Alert fired" }] };
    const result = appendSlackLegacyAttachmentText("Check this out", raw);
    expect(result).toBe("Check this out\n[attachment] Alert fired");
  });

  it("returns empty string when both are empty", () => {
    expect(appendSlackLegacyAttachmentText("", [])).toBe("");
    expect(appendSlackLegacyAttachmentText(undefined, undefined)).toBe("");
  });
});
