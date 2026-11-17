/**
 * Decide whether an email that only CCs the bot's account asks it for work.
 *
 * People CC the account to keep it in the loop, and reply-all keeps it on
 * the thread. Only the sender's words tell an ask from a note to the other
 * recipients, so the host decision model makes that choice, not a keyword
 * match.
 */
import type { PluginDecider } from "@sentry/junior-plugin-api";

/**
 * Return whether the sender's message asks the assistant behind
 * `accountEmail` to do something. `message` is the text that would become
 * the sender's first Message.
 */
export async function emailAsksAccount(
  decider: PluginDecider,
  input: { accountEmail: string; message: string },
): Promise<boolean> {
  const { choice } = await decider.decide({
    criteria: {
      asks: "The sender asks the assistant to do something, such as schedule a meeting, find a time, or look into the email.",
      informs:
        "The sender writes to the other recipients. They ask the assistant nothing, or only keep it informed.",
    },
    instructions: `An assistant uses the email account ${input.accountEmail}. This email lists that account only as a CC or BCC recipient, so it may only keep the assistant informed. Judge from the sender's own words whether they ask the assistant to do something.`,
    state: input.message,
  });
  return choice === "asks";
}
