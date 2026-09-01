import { describe, expect, it } from "vitest";
import {
  createResourceEventSource,
  createSlackSource,
  sourceSchema,
} from "@sentry/junior-plugin-api";

describe("plugin source helpers", () => {
  it("accepts Slack source visibility from the runtime boundary", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "public",
      }),
    ).toMatchObject({ kind: "slack", visibility: "public" });
    // Modern Slack private channels also use C-prefixed ids.
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "private",
      }),
    ).toMatchObject({ visibility: "private" });
  });

  it("constructs private Slack sources from caller-provided visibility", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "private",
      }),
    ).toMatchObject({ visibility: "private" });
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "G123",
        visibility: "private",
      }),
    ).toMatchObject({ visibility: "private" });
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "D123",
        visibility: "private",
      }),
    ).toMatchObject({ visibility: "private" });
  });

  it("removes Location from a stored legacy Source", () => {
    expect(
      sourceSchema.parse({
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1712345.0001",
        visibility: "private",
        location: {
          id: "location-123",
          provider: "slack",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1712345.0001",
        },
      }),
    ).toEqual({
      kind: "slack",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1712345.0001",
      visibility: "private",
    });
  });

  it("builds a Resource event Source from event identity", () => {
    expect(
      createResourceEventSource({
        eventKey: "delivery-1",
        eventType: "issue.updated",
        identifier: "PROJ-123",
        namespace: "sentry",
      }),
    ).toEqual({
      kind: "resource_event",
      eventKey: "delivery-1",
      eventType: "issue.updated",
      identifier: "PROJ-123",
      namespace: "sentry",
    });
    expect(
      sourceSchema.safeParse({
        platform: "resource_event",
        eventKey: "delivery-1",
        eventType: "issue.updated",
        identifier: "PROJ-123",
        namespace: "sentry",
      }).success,
    ).toBe(false);
  });

  it("accepts Scheduled task, event task, Plugin dispatch, and Agent invocation Sources", () => {
    for (const kind of [
      "scheduled_task",
      "event_task",
      "plugin_dispatch",
      "agent_invocation",
    ] as const) {
      expect(sourceSchema.parse({ kind })).toEqual({ kind });
    }
  });
});
