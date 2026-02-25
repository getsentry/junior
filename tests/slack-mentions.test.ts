import { afterEach, describe, expect, it, vi } from "vitest";
import {
  messageExplicitlyMentionsBot,
  registerKnownBotMention,
  resetSlackMentionsStateForTest,
  resolveSlackBotUserId,
  stripLeadingBotMention
} from "@/chat/slack-mentions";

const ORIGINAL_SLACK_BOT_USER_ID = process.env.SLACK_BOT_USER_ID;
const ORIGINAL_SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("slack mentions", () => {
  afterEach(() => {
    restoreEnv("SLACK_BOT_USER_ID", ORIGINAL_SLACK_BOT_USER_ID);
    restoreEnv("SLACK_BOT_TOKEN", ORIGINAL_SLACK_BOT_TOKEN);
    resetSlackMentionsStateForTest();
    vi.restoreAllMocks();
  });

  it("detects username mentions", () => {
    expect(messageExplicitlyMentionsBot("can @junior help?", { userName: "junior" })).toBe(true);
  });

  it("detects Slack ID mentions when the bot user ID is known", () => {
    expect(
      messageExplicitlyMentionsBot("<@U123456> can you help?", {
        userName: "junior",
        botUserId: "U123456"
      })
    ).toBe(true);

    expect(
      messageExplicitlyMentionsBot("<@U123456|junior> can you help?", {
        userName: "junior",
        botUserId: "U123456"
      })
    ).toBe(true);
  });

  it("does not treat other user mentions as bot mentions", () => {
    expect(
      messageExplicitlyMentionsBot("<@U999999> can you help?", {
        userName: "junior",
        botUserId: "U123456"
      })
    ).toBe(false);
  });

  it("strips leading bot mention by username or Slack ID", () => {
    expect(stripLeadingBotMention("@junior: hello there", { userName: "junior" })).toBe("hello there");

    expect(
      stripLeadingBotMention("<@U123456> hello there", {
        userName: "junior",
        botUserId: "U123456"
      })
    ).toBe("hello there");
  });

  it("prefers configured SLACK_BOT_USER_ID", async () => {
    process.env.SLACK_BOT_USER_ID = "UCONFIGURED";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(resolveSlackBotUserId()).resolves.toBe("UCONFIGURED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discovers bot user id with auth.test and caches it", async () => {
    delete process.env.SLACK_BOT_USER_ID;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          user_id: "UDISCOVERED"
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    await expect(resolveSlackBotUserId()).resolves.toBe("UDISCOVERED");
    await expect(resolveSlackBotUserId()).resolves.toBe("UDISCOVERED");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("learns bot user id from mention-only app_mention text", async () => {
    delete process.env.SLACK_BOT_USER_ID;
    delete process.env.SLACK_BOT_TOKEN;

    registerKnownBotMention("<@ULEARNED123> hi", "junior");

    await expect(resolveSlackBotUserId()).resolves.toBe("ULEARNED123");
  });
});
