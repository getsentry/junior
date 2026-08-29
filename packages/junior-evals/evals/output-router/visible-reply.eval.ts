/**
 * Conversation coverage for the optional visible-reply prepare path.
 *
 * These cases run the full Slack/runtime harness with scripted assistant
 * text, then assert what actually posts after prepare. Fixtures are
 * transcript-shaped (real long answers, silence tags, protocol explanations).
 */
import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { OUTPUT_REPLY_SOFT_MAX_CHARS } from "@/chat/services/output-router";
import {
  mention,
  rubric,
  slackEvals,
  visibleAssistantText,
  visibleThreadReplies,
} from "../../src/helpers";

/** Real long steering comparison that should not post as a wall of text. */
const LONG_STEERING_ESSAY = [
  "**yeah — steering is the weaker half of this comparison.** openclaw treats mid-run guidance as the default path; junior treats it as a gated special case. that mismatch is the reliability gap.",
  "",
  "### what openclaw does",
  "",
  "- default queue mode is **`steer`** for normal inbound messages while a run is active",
  "- injects at **tool-launch + model** boundaries; unfinished sequential tools get synthetic `Skipped due to queued user message.` results, then the steer is model-visible before the next decision",
  "- if the runtime can’t accept a steer, it **falls back to followup** instead of dropping",
  "- explicit `/steer <msg>` works **independent of queue mode**; `/queue interrupt|followup|collect` are first-class",
  "",
  "### what junior does",
  "",
  "1. **hard eligibility gate before anything mid-run**",
  '   - mailbox `delivery: "interrupt"` only if `isMention` **or** leading `!!`',
  "   - otherwise `defer` → waits for the turn to finish",
  "",
  "2. **cross-actor default is inverted vs openclaw**",
  "   - `JUNIOR_CROSS_ACTOR_MID_RUN_MODE` defaults to **`follow_up`**",
  "   - mid-run accept only if: mode=`steer` **or** same author as active turn **or** `!!`",
  "",
  "3. **drain is late**",
  "   - steers are injected in `prepareNextTurnWithContext` only (after a tool finishes, before the next model call)",
  "   - `beforeToolCall` does **not** skip unstarted tools for a pending steer",
  "   - long tool / parallel tool batches keep going until the next model boundary",
  "",
  "4. **docs oversell the UX**",
  '- “reply with plain language… course-correct at any point”',
  "   - code reality: plain non-mention reply mid-run is usually a **follow-up**, not a steer",
  "   - `!!` exists as the override, but it’s basically an internal escape hatch, not a real user contract",
  "",
  "### why it feels flaky",
  "",
  "| situation | junior | openclaw |",
  "|---|---|---|",
  "| plain reply mid-run, no `@` | usually waits (`defer`) | steers (default) |",
  "| `@jr stop` mid-run, same author | steers at **next model** boundary | steers earlier (tool-launch too) |",
  "| other person `@jr …` | waits unless mode=`steer` or `!!` | steers (sender labeled) |",
  "| steer while tools still queued | tools keep running | unstarted tools skipped |",
  "| inject fails | often warn + soft fail | park → followup fallback |",
  "",
  "### bottom line",
  "",
  "openclaw: **steer-by-default + early boundary + never drop**.",
  "",
  "junior: **mention/`!!`-gated + model-boundary-only + cross-actor follow_up default**.",
  "",
  "so “ours isn’t working reliably” is less random failure and more **product/runtime contract**: most of what people think is steering is actually deferred follow-up, and even real steers land later than openclaw’s.",
  "",
  "if you want parity, the minimum set is roughly:",
  "",
  "1. default mid-run path closer to openclaw `steer` (at least same-thread subscribed traffic)",
  "2. drain / skip at tool-launch, not only `prepareNextTurn`",
  "3. guaranteed fallback to next-turn follow-up when inject can’t land",
  "4. docs that match the real gates (`@` / `!!` / cross-actor mode)",
  "",
  "want me to turn that into a concrete junior issue/PR plan?",
].join("\n");

describeEval("Visible Reply Prepare", slackEvals, (it) => {
  it("when the assistant writes a long explanatory essay, post a short reply", async ({
    run,
  }) => {
    expect(LONG_STEERING_ESSAY.length).toBeGreaterThan(
      OUTPUT_REPLY_SOFT_MAX_CHARS,
    );

    const result = await run({
      overrides: {
        reply_texts: [LONG_STEERING_ESSAY],
      },
      initialEvents: [
        mention(
          "how does junior steering compare to openclaw? keep it practical",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The reply is short and readable for Slack (about a few sentences or a tight bullet list).",
          "The reply still covers the core gap: junior steers less by default and later than openclaw.",
        ],
        fail: [
          "Do not post the full multi-section essay, markdown table, or long numbered parity plan as the visible reply.",
          "Do not open with process narration about checking docs or writing an essay.",
        ],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
    expect(visibleAssistantText(result.session).length).toBeLessThanOrEqual(
      OUTPUT_REPLY_SOFT_MAX_CHARS,
    );
  });

  it("when maintain work ends with status chatter and a silence marker, stay silent", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: [
          [
            "Same main baseline miss on createAgentDispatchWorkRouter — not caused by this PR. No PR fix.",
            "",
            NO_REPLY_MARKER,
          ].join("\n"),
        ],
      },
      initialEvents: [
        mention(
          "check the PR checks for the guardian ordinary-writes change and only ping if something needs a fix",
        ),
      ],
      requireSandboxReady: false,
    });

    expect(visibleThreadReplies(result.session)).toEqual([]);
    expect(visibleAssistantText(result.session)).not.toContain(NO_REPLY_MARKER);
  });

  it("when asked how silence works, keep the explanation visible", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: [
          [
            `Intentional silence uses the exact whole-message marker ${NO_REPLY_MARKER}.`,
            "If the marker is only mentioned in a normal answer, that answer should still post.",
            "Only a message that is exactly the marker stays silent.",
          ].join(" "),
        ],
      },
      initialEvents: [
        mention(
          "how does junior's no-reply marker work? when does a message stay silent?",
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The reply explains that silence requires the whole message to be the marker, and that ordinary answers can still mention it.",
        ],
        fail: [
          "Do not stay silent or drop the explanation just because the marker string appears in the answer.",
        ],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
    const text = visibleAssistantText(result.session);
    expect(text.length).toBeGreaterThan(0);
    expect(/silence|marker|exact/i.test(text)).toBe(true);
  });
});
