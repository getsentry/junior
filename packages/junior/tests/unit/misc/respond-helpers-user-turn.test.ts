import { describe, expect, it } from "vitest";
import { buildUserTurnText } from "@/chat/respond-helpers";

describe("buildUserTurnText marker ordering", () => {
  it("returns raw input when no context or metadata is provided", () => {
    expect(buildUserTurnText("hello")).toBe("hello");
  });

  it("places thread background before the latest user instruction", () => {
    const result = buildUserTurnText(
      "current ask",
      "<thread-transcript>\n[user] alice: earlier\n</thread-transcript>",
    );

    const backgroundIndex = result.indexOf("<thread-background>");
    const instructionIndex = result.indexOf(
      '<latest-user-instruction priority="highest">',
    );

    expect(backgroundIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeGreaterThan(backgroundIndex);
  });

  it("emits the latest user instruction as the final section", () => {
    const result = buildUserTurnText(
      "current ask",
      "<thread-transcript>\n[user] alice: earlier\n</thread-transcript>",
      {
        sessionContext: { conversationId: "c-1" },
        turnContext: { traceId: "t-1" },
      },
    );

    expect(result.trimEnd().endsWith("</latest-user-instruction>")).toBe(true);
  });

  it("emits an instruction precedence block before the latest instruction", () => {
    const result = buildUserTurnText(
      "current ask",
      "<thread-transcript>\n[user] alice: earlier\n</thread-transcript>",
    );

    const precedenceIndex = result.indexOf("<instruction-precedence>");
    const instructionIndex = result.indexOf(
      '<latest-user-instruction priority="highest">',
    );

    expect(precedenceIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeGreaterThan(precedenceIndex);
  });

  it("tags the latest user instruction with the highest priority", () => {
    const result = buildUserTurnText(
      "current ask",
      "<thread-transcript>\n[user] alice: earlier\n</thread-transcript>",
    );

    expect(result).toContain('<latest-user-instruction priority="highest">');
  });

  it("includes session and turn observability metadata when provided", () => {
    const result = buildUserTurnText("current ask", undefined, {
      sessionContext: { conversationId: "c-1" },
      turnContext: { traceId: "t-1" },
    });

    expect(result).toContain("<session-context>");
    expect(result).toContain("gen_ai.conversation.id: c-1");
    expect(result).toContain("<turn-context>");
    expect(result).toContain("trace_id: t-1");
  });

  it("does not emit the legacy current-message or thread-conversation-context wrappers", () => {
    const result = buildUserTurnText(
      "current ask",
      "<thread-transcript>\n[user] alice: earlier\n</thread-transcript>",
    );

    expect(result).not.toContain("<current-message>");
    expect(result).not.toContain("<thread-conversation-context>");
  });
});
