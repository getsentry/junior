import { describe, expect, it, vi } from "vitest";
import {
  fallbackShortTitle,
  generateShortTitle,
  normalizeShortTitle,
  resolveTaskTitle,
} from "@/chat/services/short-title";

describe("normalizeShortTitle", () => {
  it("collapses whitespace and caps length", () => {
    expect(normalizeShortTitle("  weekly   digest  ")).toBe("weekly digest");
    expect(normalizeShortTitle("x".repeat(80))).toHaveLength(60);
  });
});

describe("fallbackShortTitle", () => {
  it("uses the first non-empty line", () => {
    expect(
      fallbackShortTitle("\n  Send the weekly project summary\nwith details"),
    ).toBe("Send the weekly project summary");
  });

  it("returns the fallback when source text is empty", () => {
    expect(fallbackShortTitle("   \n  ", "Untitled task")).toBe(
      "Untitled task",
    );
  });
});

describe("generateShortTitle", () => {
  it("returns a normalized model title for task instructions", async () => {
    const completeText = vi.fn(
      async (params: { messages: Array<{ content: string }> }) => {
        expect(params.messages[0]?.content).toContain("Task instruction:");
        return { text: "  Weekly project summary.  " };
      },
    );

    await expect(
      generateShortTitle({
        completeText: completeText as never,
        kind: "task",
        sourceText: "Send the weekly project summary every Monday",
      }),
    ).resolves.toBe("Weekly project summary.");

    expect(completeText).toHaveBeenCalledOnce();
  });

  it("returns undefined when generation fails", async () => {
    const completeText = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });

    await expect(
      generateShortTitle({
        completeText: completeText as never,
        kind: "conversation",
        sourceText: "Help me debug this incident",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveTaskTitle", () => {
  it("prefers an explicit title over model generation", async () => {
    const completeText = vi.fn(async () => ({
      text: "Generated title",
    }));

    await expect(
      resolveTaskTitle({
        completeText: completeText as never,
        instruction: "Send the weekly project summary",
        title: "  Weekly ops digest  ",
      }),
    ).resolves.toBe("Weekly ops digest");
    expect(completeText).not.toHaveBeenCalled();
  });

  it("falls back to generation when no title is provided", async () => {
    const completeText = vi.fn(async () => ({
      text: "Weekly project summary",
    }));

    await expect(
      resolveTaskTitle({
        completeText: completeText as never,
        instruction: "Send the weekly project summary",
      }),
    ).resolves.toBe("Weekly project summary");
    expect(completeText).toHaveBeenCalledOnce();
  });
});
