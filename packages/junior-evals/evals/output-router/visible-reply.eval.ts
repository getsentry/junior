/**
 * Isolated visible-reply prepare corpus.
 *
 * Each case feeds real assistant-message text into prepareAssistantReply and
 * asserts silent vs reply. This suite does not run the main agent or Slack
 * transport. Delivery wiring is covered elsewhere.
 */
import { describeEval } from "vitest-evals";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { OUTPUT_REPLY_SOFT_MAX_CHARS } from "@/chat/services/output-router";
import { outputRouterEvals } from "../../src/output-router-harness";

/** Real long steering comparison that should not remain a wall of text. */
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

/** Real maintain-PR status chatter that should stay silent. */
const STATUS_ONLY_WITH_MARKER = [
  "Same main baseline miss on createAgentDispatchWorkRouter — not caused by this PR. No PR fix.",
  "",
  NO_REPLY_MARKER,
].join("\n");

/** Real explanation of silence that must stay a reply. */
const SILENCE_PROTOCOL_EXPLANATION = [
  `Intentional silence uses the exact whole-message marker ${NO_REPLY_MARKER}.`,
  "If the marker is only mentioned in a normal answer, that answer should still post.",
  "Only a message that is exactly the marker stays silent.",
].join(" ");

describeEval("Visible Reply Prepare", outputRouterEvals, (it) => {
  it("when the assistant writes a long explanatory essay, return a short reply", async ({
    run,
  }) => {
    if (LONG_STEERING_ESSAY.length <= OUTPUT_REPLY_SOFT_MAX_CHARS) {
      throw new Error("fixture must exceed the soft max length");
    }

    await run({
      text: LONG_STEERING_ESSAY,
      expectedKind: "reply",
      maxChars: OUTPUT_REPLY_SOFT_MAX_CHARS,
      mustInclude: ["steer"],
      mustNotInclude: ["### what openclaw does", "| situation | junior |"],
    });
  });

  it("when maintain work ends with status chatter and a silence marker, stay silent", async ({
    run,
  }) => {
    await run({
      text: STATUS_ONLY_WITH_MARKER,
      expectedKind: "silent",
    });
  });

  it("when the message explains how silence works, keep the explanation", async ({
    run,
  }) => {
    await run({
      text: SILENCE_PROTOCOL_EXPLANATION,
      expectedKind: "reply",
      mustInclude: ["marker", "exact"],
    });
  });

  it("when the whole message is only the silence marker, stay silent", async ({
    run,
  }) => {
    await run({
      text: NO_REPLY_MARKER,
      expectedKind: "silent",
    });
  });
});
