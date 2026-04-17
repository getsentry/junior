import { describe, expect, it, vi } from "vitest";
import {
  createReplyTool,
  replyToolInputSchema,
} from "@/chat/slack/render/reply-tool";
import type { SlackRenderIntent } from "@/chat/slack/render/intents";

describe("createReplyTool", () => {
  it("captures a validated summary_card intent and returns an acknowledgement", async () => {
    const captured: SlackRenderIntent[] = [];
    const tool = createReplyTool({
      captureReplyIntent: (intent) => captured.push(intent),
    });

    const result = await tool.execute?.(
      {
        kind: "summary_card",
        title: "Reduce noisy retry logs",
        subtitle: "PR #123 · dcramer/acme",
        fields: [
          { label: "Status", value: "Open" },
          { label: "Author", value: "dcramer" },
        ],
        actions: [
          { label: "View PR", url: "https://github.com/dcramer/acme/pull/123" },
        ],
      },
      {},
    );

    expect(result).toEqual({ ok: true, kind: "summary_card" });
    expect(captured).toHaveLength(1);
    const intent = captured[0]!;
    expect(intent.kind).toBe("summary_card");
    if (intent.kind !== "summary_card") throw new Error("unexpected kind");
    expect(intent.title).toBe("Reduce noisy retry logs");
    expect(intent.fields).toHaveLength(2);
  });

  it("captures a plain_reply intent", async () => {
    const captured: SlackRenderIntent[] = [];
    const tool = createReplyTool({
      captureReplyIntent: (intent) => captured.push(intent),
    });

    await tool.execute?.(
      { kind: "plain_reply", text: "Noted — will follow up tomorrow." },
      {},
    );

    expect(captured[0]).toEqual({
      kind: "plain_reply",
      text: "Noted — will follow up tomorrow.",
    });
  });

  it("rejects a summary_card missing a required title", () => {
    const capture = vi.fn();
    const tool = createReplyTool({ captureReplyIntent: capture });

    // The TypeBox-level schema allows pi-agent-core / the provider to
    // reject this before execute fires, but the Zod cross-validation in
    // execute is the safety net if that upstream check is bypassed.
    expect(() =>
      // Cast through unknown because we're intentionally violating the
      // schema to prove the runtime validation holds.
      tool.execute?.(
        { kind: "summary_card" } as unknown as Parameters<
          NonNullable<typeof tool.execute>
        >[0],
        {},
      ),
    ).toThrow(/title/);
    expect(capture).not.toHaveBeenCalled();
  });

  it("exposes the TypeBox discriminated union to the provider", () => {
    // Every documented kind must be reachable through the top-level
    // union so the provider can present them as valid options.
    const kinds = new Set<string>();
    for (const member of replyToolInputSchema.anyOf) {
      const kindSchema = (
        member as { properties?: { kind?: { const?: unknown } } }
      ).properties?.kind;
      if (kindSchema && typeof kindSchema.const === "string") {
        kinds.add(kindSchema.const);
      }
    }
    expect(kinds).toEqual(
      new Set([
        "plain_reply",
        "summary_card",
        "alert",
        "comparison_table",
        "result_carousel",
        "progress_plan",
      ]),
    );
  });
});
