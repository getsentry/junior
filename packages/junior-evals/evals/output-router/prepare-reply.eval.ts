/**
 * Isolated output-router corpus.
 *
 * Each case feeds exact assistant message text to prepareAssistantReply and
 * asserts only silent vs reply. Fixtures are real failure shapes, not product
 * prompt examples.
 */
import { describeEval } from "vitest-evals";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { OUTPUT_REPLY_SOFT_MAX_CHARS } from "@/chat/services/output-router";
import { outputRouterEvals } from "../../src/output-router-harness";

describeEval("Output Router Snapshots", outputRouterEvals, (it) => {
  it("when the whole message is the silence marker, stay silent", async ({
    run,
  }) => {
    await run({
      expectedKind: "silent",
      text: NO_REPLY_MARKER,
    });
  });

  it("when status-only chatter ends with the silence marker, stay silent", async ({
    run,
  }) => {
    // Real maintain-PR shape: process note + protocol silence, no user answer.
    await run({
      expectedKind: "silent",
      text: [
        "Same main baseline miss on createAgentDispatchWorkRouter — not caused by this PR. No PR fix.",
        "",
        NO_REPLY_MARKER,
      ].join("\n"),
    });
  });

  it("when a real answer mentions the silence marker, keep the answer", async ({
    run,
  }) => {
    const result = await run({
      expectedKind: "reply",
      text: `Earlier turn used ${NO_REPLY_MARKER} and then stopped.`,
    });
    const text = String(result.output.text ?? "");
    if (!text.toLowerCase().includes("earlier turn")) {
      throw new Error(`Expected the real answer to remain visible, got: ${text}`);
    }
    if (text.includes(NO_REPLY_MARKER)) {
      throw new Error(`Expected the marker stripped from visible text, got: ${text}`);
    }
  });

  it("when the reply is already short and clear, keep it", async ({ run }) => {
    const result = await run({
      expectedKind: "reply",
      text: "Draft PR is up: https://github.com/getsentry/junior/pull/1732",
    });
    const text = String(result.output.text ?? "");
    if (!text.includes("1732")) {
      throw new Error(`Expected the PR link to remain, got: ${text}`);
    }
  });

  it("when the reply is far too long, shorten it", async ({ run }) => {
    const filler =
      "This section repeats background that is not needed in the final Slack reply. ";
    const longText = [
      "Here is the outcome: the migration landed and traffic is healthy.",
      "Next step: watch error rate for 30 minutes.",
      filler.repeat(40),
      "Also keep the deploy link: https://example.test/deploy/42",
    ].join("\n");
    const result = await run({
      expectedKind: "reply",
      maxVisibleChars: OUTPUT_REPLY_SOFT_MAX_CHARS,
      text: longText,
    });
    const text = String(result.output.text ?? "");
    if (!/migration|healthy|error rate|deploy/i.test(text)) {
      throw new Error(
        `Expected the shortened reply to keep the outcome, got: ${text}`,
      );
    }
  });
});
