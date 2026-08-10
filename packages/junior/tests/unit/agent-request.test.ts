import { describe, expect, it } from "vitest";
import { createLocalSource, createWebSource } from "@sentry/junior-plugin-api";
import { assertRunRoutingConsistency } from "@/chat/agent/request";

describe("agent run routing", () => {
  it("allows an internal child run to borrow its parent's local route", () => {
    expect(() =>
      assertRunRoutingConsistency({
        conversationId: "local:test:child",
        routing: {
          destination: {
            conversationId: "local:test:parent",
            platform: "local",
          },
          source: createLocalSource("local:test:parent"),
          surface: "internal",
        },
      }),
    ).not.toThrow();
  });

  it("rejects the same local route mismatch outside internal work", () => {
    expect(() =>
      assertRunRoutingConsistency({
        conversationId: "local:test:child",
        routing: {
          destination: {
            conversationId: "local:test:parent",
            platform: "local",
          },
          source: createLocalSource("local:test:parent"),
        },
      }),
    ).toThrow(
      "Source, destination, and run conversation IDs do not match",
    );
  });

  it("rejects contradictory local parent routing for internal child work", () => {
    expect(() =>
      assertRunRoutingConsistency({
        conversationId: "local:test:child",
        routing: {
          destination: {
            conversationId: "local:test:other-parent",
            platform: "local",
          },
          source: createLocalSource("local:test:parent"),
          surface: "internal",
        },
      }),
    ).toThrow("Source and destination conversation IDs do not match");
  });

  it("allows a web continue on a Slack destination without external publish", () => {
    expect(() =>
      assertRunRoutingConsistency({
        conversationId: "slack:C123:1712345.0001",
        routing: {
          actor: {
            platform: "web",
            userId: "dashboard:alice",
            email: "alice@example.com",
          },
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "C123",
          },
          publishExternally: false,
          source: createWebSource("slack:C123:1712345.0001", "public"),
          surface: "api",
        },
      }),
    ).not.toThrow();
  });

  it("rejects a web continue that would publish to Slack", () => {
    expect(() =>
      assertRunRoutingConsistency({
        conversationId: "slack:C123:1712345.0001",
        routing: {
          actor: {
            platform: "web",
            userId: "dashboard:alice",
            email: "alice@example.com",
          },
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "C123",
          },
          publishExternally: true,
          source: createWebSource("slack:C123:1712345.0001", "public"),
          surface: "api",
        },
      }),
    ).toThrow("Web turns on Slack destinations must not publish externally");
  });
});
