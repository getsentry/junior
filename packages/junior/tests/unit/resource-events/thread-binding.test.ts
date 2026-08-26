import { createSlackSource, createWebSource } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import {
  RESOURCE_WATCH_THREAD_REQUIRED_MESSAGE,
  requireResourceWatchThread,
  resolveResourceWatchThread,
} from "@/chat/resource-events/tool-support";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const destination = {
  platform: "slack" as const,
  teamId: "T123",
  channelId: "C123",
};

describe("resource watch thread binding", () => {
  it("prefers the live Slack source thread over an opaque conversation id", () => {
    expect(
      resolveResourceWatchThread({
        conversationId: "agent:child",
        destination,
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",
          threadTs: "1712345.0001",
          visibility: "public",
        }),
      }),
    ).toEqual({
      conversationId: "slack:C123:1712345.0001",
      destination,
    });
  });

  it("accepts a Slack-thread conversation id for web continues", () => {
    expect(
      resolveResourceWatchThread({
        conversationId: "slack:C123:1712345.0001",
        destination,
        source: createWebSource("slack:C123:1712345.0001", "public"),
      }),
    ).toEqual({
      conversationId: "slack:C123:1712345.0001",
      destination,
    });
  });

  it("rejects channel-level Slack sources without a thread", () => {
    expect(
      resolveResourceWatchThread({
        conversationId: "agent-dispatch:task-1",
        destination,
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",
          visibility: "public",
        }),
      }),
    ).toBeUndefined();
    expect(() =>
      requireResourceWatchThread({
        conversationId: "agent-dispatch:task-1",
        destination,
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",
          visibility: "public",
        }),
      }),
    ).toThrow(ToolInputError);
    expect(() =>
      requireResourceWatchThread({
        conversationId: "agent-dispatch:task-1",
        destination,
        source: createSlackSource({
          teamId: "T123",
          channelId: "C123",
          visibility: "public",
        }),
      }),
    ).toThrow(RESOURCE_WATCH_THREAD_REQUIRED_MESSAGE);
  });
});
