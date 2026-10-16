import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import { buildTurnContextPrompt } from "@/chat/prompt";
import { buildToolActionEvidence } from "@/chat/tool-support/action-review-evidence";

/** Incomplete transcript fixtures for evidence selection tests. */
function piMessage(value: unknown): PiMessage {
  return value as PiMessage;
}

describe("tool action review evidence", () => {
  it("keeps user, assistant, tool-call, and tool-result evidence without reasoning", () => {
    const evidence = buildToolActionEvidence([
      {
        role: "user",
        content: [{ type: "text", text: "Create the weekly report." }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hidden chain of thought." },
          { type: "text", text: "I will inspect the report first." },
          {
            type: "toolCall",
            id: "call-1",
            name: "readReport",
            arguments: { cadence: "weekly" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "readReport",
        content: [{ type: "text", text: "The weekly report exists." }],
        isError: false,
      },
    ].map((value) => piMessage(value)));

    expect(evidence).toEqual({
      entries: [
        { role: "user", text: "Create the weekly report." },
        {
          role: "assistant",
          text: "I will inspect the report first.",
        },
        {
          role: "tool readReport call",
          text: '{"cadence":"weekly"}',
        },
        {
          role: "tool readReport result",
          text: "The weekly report exists.",
        },
      ],
      omittedEntries: 0,
    });
    expect(JSON.stringify(evidence)).not.toContain("Hidden chain");
  });

  it("labels Conversation notes as notes, never as a user or parent agent", () => {
    const note =
      "A parent agent above you stopped your watch w-1 (Deploy & build).";
    const turnContext = buildTurnContextPrompt({
      availableSkills: [],
      conversationNotes: {
        notes: [{ createdAtMs: 0, text: note }],
        omittedCount: 0,
      },
      includeSessionContext: false,
    });
    const messages = [
      { role: "user", content: [{ type: "text", text: turnContext }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<current-instruction>\nCheck the deploy.\n</current-instruction>",
          },
        ],
      },
    ].map((value) => piMessage(value));

    for (const childAgent of [false, true]) {
      const { entries } = buildToolActionEvidence(messages, { childAgent });
      expect(entries.filter((entry) => entry.text.includes(note))).toEqual([
        {
          role: "conversation note",
          text: expect.stringContaining(`- 1970-01-01T00:00:00.000Z: ${note}`),
        },
      ]);
      expect(entries.at(-1)).toEqual({
        role: childAgent ? "parent agent" : "user",
        text: "Check the deploy.",
      });
    }
  });

  it("preserves first and latest user anchors while retaining recent tool evidence", () => {
    const messageFixtures = [
      {
        role: "user",
        content: [{ type: "text", text: "first-request" }],
      },
      ...Array.from(
        { length: 12 },
        (_, index) =>
          ({
            role: "user",
            content: [{ type: "text", text: `${index}-${"x".repeat(8_000)}` }],
          }),
      ),
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-latest",
            name: "inspectTarget",
            arguments: { target: "preview-73" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-latest",
        toolName: "inspectTarget",
        content: [{ type: "text", text: "target is an empty preview" }],
        isError: false,
      },
      {
        role: "user",
        content: [{ type: "text", text: "latest-request" }],
      },
    ];

    const evidence = buildToolActionEvidence(messageFixtures.map((value) => piMessage(value)));

    expect(evidence.entries[0]).toEqual({
      role: "user",
      text: "first-request",
    });
    expect(evidence.entries.at(-1)).toEqual({
      role: "user",
      text: "latest-request",
    });
    expect(evidence.entries).toContainEqual({
      role: "tool inspectTarget call",
      text: '{"target":"preview-73"}',
    });
    expect(evidence.entries).toContainEqual({
      role: "tool inspectTarget result",
      text: "target is an empty preview",
    });
    expect(evidence.omittedEntries).toBeGreaterThan(0);
  });
});
