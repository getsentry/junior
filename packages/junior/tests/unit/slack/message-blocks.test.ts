import { describe, expect, it } from "vitest";
import { renderBlockText } from "@/chat/slack/message/blocks";

describe("renderBlockText", () => {
  it("renders nested Block Kit content", () => {
    const text = renderBlockText([
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
    ]);

    expect(text).toBe(
      [
        "Taylor Example",
        "full star",
        "Play Store • v.3.2.13",
        "Translate to",
        "Read full review (https://example.com/review/123)",
      ].join("\n"),
    );
    expect(text).not.toContain("private-action-value");
    expect(text).not.toContain("English");
    expect(text).not.toContain("full-star.png");
  });

  it("renders rich text entities and links", () => {
    const text = renderBlockText([
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "text", text: "Owner" },
              { type: "user", user_id: "U123" },
              { type: "channel", channel_id: "C123" },
              { type: "usergroup", usergroup_id: "S123" },
              { type: "broadcast", range: "here" },
              { type: "emoji", name: "wave" },
              {
                type: "link",
                text: "Runbook",
                url: "https://example.com/runbook",
              },
            ],
          },
        ],
      },
    ]);

    expect(text).toBe(
      [
        "Owner",
        "<@U123>",
        "<#C123>",
        "<!subteam^S123>",
        "<!here>",
        ":wave:",
        "Runbook (https://example.com/runbook)",
      ].join("\n"),
    );
  });

  it("includes visible choice labels without exposing action values", () => {
    const text = renderBlockText([
      {
        type: "actions",
        elements: [
          {
            type: "checkboxes",
            options: [
              {
                text: { type: "plain_text", text: "Notify owner" },
                value: "private-owner-id",
              },
            ],
          },
          {
            type: "radio_buttons",
            options: [
              {
                text: { type: "plain_text", text: "High priority" },
                value: "private-priority-id",
              },
            ],
          },
        ],
      },
    ]);

    expect(text).toBe("Notify owner\nHigh priority");
    expect(text).not.toContain("private-owner-id");
    expect(text).not.toContain("private-priority-id");
  });

  it("returns empty text for values that are not a block array", () => {
    expect(renderBlockText(undefined)).toBe("");
    expect(renderBlockText(null)).toBe("");
    expect(renderBlockText({ blocks: [] })).toBe("");
  });
});
