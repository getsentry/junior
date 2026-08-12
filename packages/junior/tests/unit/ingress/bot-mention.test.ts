import { describe, expect, it } from "vitest";
import { textMentionsBot } from "@/chat/ingress/bot-mention";

const BOT = "U0BOT";

describe("textMentionsBot", () => {
  it("detects a plain or labeled bot mention outside code", () => {
    expect(textMentionsBot(`hey <@${BOT}> status?`, BOT)).toBe(true);
    expect(textMentionsBot(`hey <@${BOT}|junior> status?`, BOT)).toBe(true);
  });

  it("ignores mentions only inside inline code or a fenced block", () => {
    expect(textMentionsBot(`use \`<@${BOT}>\` to ping`, BOT)).toBe(false);
    expect(
      textMentionsBot(
        ["example:", "```", `<@${BOT}> hello`, "```"].join("\n"),
        BOT,
      ),
    ).toBe(false);
  });

  it("still detects a real mention beside code examples", () => {
    expect(
      textMentionsBot(
        [`<@${BOT}> please help`, "", "```", `<@${BOT}> example`, "```"].join(
          "\n",
        ),
        BOT,
      ),
    ).toBe(true);
    expect(
      textMentionsBot(`see \`<@${BOT}>\` then <@${BOT}> run it`, BOT),
    ).toBe(true);
  });

  it("does not treat mid-line triple backticks as a fence", () => {
    expect(
      textMentionsBot(`Use \`\`\` for blocks and <@${BOT}> will help`, BOT),
    ).toBe(true);
  });

  it("detects a mention after a same-line fence close", () => {
    expect(
      textMentionsBot("```code``` " + `<@${BOT}> help`, BOT),
    ).toBe(true);
  });

  it("requires an exact bot user id token", () => {
    expect(textMentionsBot(`hey <@${BOT}123> status?`, BOT)).toBe(false);
    expect(textMentionsBot(`hey <@U0OTHER> status?`, BOT)).toBe(false);
    expect(textMentionsBot("", BOT)).toBe(false);
    expect(textMentionsBot(`<@${BOT}>`, "")).toBe(false);
  });
});
