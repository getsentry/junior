import { describeEval } from "vitest-evals";
import {
  EMAIL_REQUEST_ACCOUNT,
  emailRequestIntentEvals,
} from "../../src/email-request-intent-harness";

// The sender's first Message for an email that lists the account only in Cc.
function ccMessage(subject: string, words: string): string {
  return [
    `Email subject: ${subject}`,
    "To: sam@example.com, alex@example.com",
    `Cc: ${EMAIL_REQUEST_ACCOUNT}`,
    "",
    words,
  ].join("\n");
}

describeEval("Email Request Intent", emailRequestIntentEvals, (it) => {
  it("when the sender asks the bot by name to schedule, it asks", async ({
    run,
  }) => {
    await run({
      message: ccMessage(
        "Intro: Sam <> Alex",
        "Sam, meet Alex. Junior, can you find the three of us 30 minutes next week?",
      ),
      asks: true,
    });
  });

  it("when the sender asks for work without the bot's name, it asks", async ({
    run,
  }) => {
    await run({
      message: ccMessage(
        "Re: Q4 planning",
        "Adding my assistant here. Please put a 45 minute review on our calendars before Friday.",
      ),
      asks: true,
    });
  });

  it("when the sender only loops the bot in, it informs", async ({ run }) => {
    await run({
      message: ccMessage(
        "Intro: Sam <> Alex",
        "Sam, meet Alex. I added Junior so it has the context. I'll let you two take it from here.",
      ),
      asks: false,
    });
  });

  it("when a reply-all answers the other recipients, it informs", async ({
    run,
  }) => {
    await run({
      message: ccMessage(
        "Re: Interview",
        "Thanks, Tuesday at 2pm works for me.",
      ),
      asks: false,
    });
  });

  it("when the sender thanks the bot, it informs", async ({ run }) => {
    await run({
      message: ccMessage(
        "Re: Interview",
        "Thanks Junior, that time works. See you all then.",
      ),
      asks: false,
    });
  });
});
