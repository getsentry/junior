import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import {
  isConversationWorkDone,
  listConversationWork,
  listUnfinishedWork,
} from "@/chat/plugins/unfinished-work";

describe("plugin unfinished work", () => {
  afterEach(() => setPlugins([]));

  it("combines plugin signals and ignores conversations outside the candidate set", async () => {
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "first",
          displayName: "First",
          description: "First unfinished work plugin",
        },
        hooks: {
          unfinishedWork() {
            return {
              assignedConversationIds: [
                "conversation-a",
                "conversation-finished",
                "not-a-candidate",
              ],
              conversationIds: ["conversation-a", "not-a-candidate"],
              finishedWorkAtByConversationId: {
                "conversation-finished": "2026-08-03T11:30:00.000Z",
                "not-a-candidate": "2026-08-03T12:00:00.000Z",
              },
            };
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "second",
          displayName: "Second",
          description: "Second unfinished work plugin",
        },
        hooks: {
          unfinishedWork() {
            return { conversationIds: ["conversation-b", "conversation-a"] };
          },
        },
      }),
    ]);

    await expect(
      listConversationWork([
        "conversation-a",
        "conversation-b",
        "conversation-c",
        "conversation-finished",
      ]),
    ).resolves.toEqual({
      failed: false,
      assignedIds: [
        "conversation-a",
        "conversation-b",
        "conversation-finished",
      ],
      finishedAtById: {
        "conversation-finished": "2026-08-03T11:30:00.000Z",
      },
      unfinishedIds: ["conversation-a", "conversation-b"],
    });
    await expect(
      listUnfinishedWork([
        "conversation-a",
        "conversation-b",
        "conversation-c",
        "conversation-finished",
      ]),
    ).resolves.toEqual(["conversation-a", "conversation-b"]);
  });

  it("keeps successful plugin signals when one plugin fails", async () => {
    setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "working",
          displayName: "Working",
          description: "Working unfinished work plugin",
        },
        hooks: {
          unfinishedWork() {
            return {
              assignedConversationIds: ["conversation-a", "conversation-c"],
              conversationIds: ["conversation-a"],
            };
          },
        },
      }),
      defineJuniorPlugin({
        manifest: {
          name: "failing",
          displayName: "Failing",
          description: "Failing unfinished work plugin",
        },
        hooks: {
          unfinishedWork() {
            throw new Error("provider unavailable");
          },
        },
      }),
    ]);

    await expect(
      listConversationWork([
        "conversation-a",
        "conversation-b",
        "conversation-c",
      ]),
    ).resolves.toEqual({
      assignedIds: ["conversation-a", "conversation-c"],
      failed: true,
      finishedAtById: {},
      unfinishedIds: ["conversation-a"],
    });
  });
});

const cutoffMs = Date.parse("2026-01-02T00:00:00.000Z");

describe("isConversationWorkDone", () => {
  it("requires finished assigned work before the cutoff", () => {
    expect(
      isConversationWorkDone(
        { assignedWork: true, finishedWorkAt: "2026-01-01T00:00:00.000Z" },
        cutoffMs,
      ),
    ).toBe(true);
    expect(
      isConversationWorkDone(
        {
          assignedWork: true,
          finishedWorkAt: "2026-01-01T00:00:00.000Z",
          unfinishedWork: true,
        },
        cutoffMs,
      ),
    ).toBe(false);
    expect(
      isConversationWorkDone(
        { assignedWork: true, finishedWorkAt: "2026-01-03T00:00:00.000Z" },
        cutoffMs,
      ),
    ).toBe(false);
  });

  it("treats a conversation without reported work as done", () => {
    expect(isConversationWorkDone({}, cutoffMs)).toBe(true);
  });

  it("keeps conversations where a person replied after the work finished", () => {
    expect(
      isConversationWorkDone(
        {
          assignedWork: true,
          finishedWorkAt: "2026-01-01T00:00:00.000Z",
          lastUserMessageAt: "2026-01-01T06:00:00.000Z",
        },
        cutoffMs,
      ),
    ).toBe(false);
  });
});
