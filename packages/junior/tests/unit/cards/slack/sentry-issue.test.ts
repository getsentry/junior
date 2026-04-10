import { describe, expect, it } from "vitest";
import { renderSlackSentryIssueCard } from "@/chat/cards/slack/sentry-issue";

describe("renderSlackSentryIssueCard", () => {
  it("builds a Slack-native attachment payload for a Sentry issue", () => {
    const rendered = renderSlackSentryIssueCard({
      data: {
        shortId: "JUNIOR-1G",
        title: "Error: An API error occurred: message_not_in_streaming_state",
        permalink: "https://sentry.example.com/issues/JUNIOR-1G",
        status: "unresolved",
        project: "junior",
        level: "error",
        count: "184",
        userCount: 12,
        lastSeen: "2 minutes ago",
        assignee: "David Cramer",
      },
      resolved: {
        title: "JUNIOR-1G",
        titleUrl: "https://sentry.example.com/issues/JUNIOR-1G",
        body: "Error: An API error occurred: message_not_in_streaming_state",
        linkLabel: "View in Sentry",
        status: {
          text: "unresolved",
          style: "danger",
        },
        fields: [
          { label: "Project", value: "junior" },
          { label: "Level", value: "error" },
        ],
        fallbackText:
          "JUNIOR-1G: Error: An API error occurred: message_not_in_streaming_state (unresolved)",
      },
    });

    expect(rendered).toMatchObject({
      attachments: [
        {
          color: "#E01E5A",
          fallback:
            "JUNIOR-1G: Error: An API error occurred: message_not_in_streaming_state (unresolved)",
          blocks: [
            expect.objectContaining({
              type: "context",
            }),
            expect.objectContaining({
              type: "section",
              accessory: expect.objectContaining({
                type: "button",
                text: expect.objectContaining({
                  text: "Open in Sentry",
                }),
              }),
            }),
            expect.objectContaining({
              type: "section",
              fields: expect.arrayContaining([
                expect.objectContaining({
                  text: "*Status*\nUnresolved",
                }),
                expect.objectContaining({
                  text: "*Project*\njunior",
                }),
              ]),
            }),
          ],
        },
      ],
    });
  });
});
