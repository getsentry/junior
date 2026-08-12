import { describe, expect, it } from "vitest";
import { textMentionsBot } from "@/chat/ingress/bot-mention";

const BOT = "U0BOT";

describe("textMentionsBot", () => {
  it("detects a plain bot mention", () => {
    expect(textMentionsBot(`hey <@${BOT}> status?`, BOT)).toBe(true);
  });

  it("detects a labeled bot mention token", () => {
    expect(textMentionsBot(`hey <@${BOT}|junior> status?`, BOT)).toBe(true);
  });

  it("ignores mentions only inside inline code", () => {
    expect(textMentionsBot(`use \`<@${BOT}>\` to ping`, BOT)).toBe(false);
    expect(textMentionsBot("use ``" + `<@${BOT}>` + "`` to ping", BOT)).toBe(
      false,
    );
    expect(
      textMentionsBot("use ```" + `<@${BOT}>` + "``` to ping", BOT),
    ).toBe(false);
  });

  it("ignores mentions only inside a fenced code block", () => {
    expect(
      textMentionsBot(
        ["example:", "```", `<@${BOT}> hello`, "```"].join("\n"),
        BOT,
      ),
    ).toBe(false);
  });

  it("does not stay stuck after a single-line fenced block", () => {
    expect(
      textMentionsBot(
        ["```" + `<@${BOT}>` + "```", `<@${BOT}> help`].join("\n"),
        BOT,
      ),
    ).toBe(true);
    expect(
      textMentionsBot(["```" + `<@${BOT}>` + "```", "no mention"].join("\n"), BOT),
    ).toBe(false);
  });

  it("keeps the fence open when ``` appears mid-line inside the block", () => {
    expect(
      textMentionsBot(
        [
          "```",
          'const fence = "```";',
          `<@${BOT}> still inside`,
          "```",
          "after the block",
        ].join("\n"),
        BOT,
      ),
    ).toBe(false);
    expect(
      textMentionsBot(
        [
          "```",
          'const fence = "```";',
          `<@${BOT}> still inside`,
          "```",
          `<@${BOT}> after`,
        ].join("\n"),
        BOT,
      ),
    ).toBe(true);
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

  it("ignores other users and empty input", () => {
    expect(textMentionsBot(`hey <@U0OTHER> status?`, BOT)).toBe(false);
    expect(textMentionsBot("", BOT)).toBe(false);
    expect(textMentionsBot(`<@${BOT}>`, "")).toBe(false);
  });
});
