/**
 * Conversation list CLI.
 *
 * Prints one JSON line for each active root Conversation of the token owner.
 * Each line has the dashboard link and, when one exists, the Slack link.
 */
import { conversationFeedSchema } from "@/api/schema/conversation";
import { apiUrl, fetchJson } from "./api-client";
import { CLI_USAGE, optionValue } from "./run";

type ListOptions = {
  baseUrl: string;
  token: string;
};

function parseListOptions(argv: string[]): ListOptions {
  let baseUrl: string | undefined;
  let token = process.env.JUNIOR_API_TOKEN?.trim();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--base-url") {
      baseUrl = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--token") {
      token = optionValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!baseUrl || !token) throw new Error(CLI_USAGE);
  return { baseUrl, token };
}

async function listConversations(options: ListOptions): Promise<void> {
  let cursor: string | undefined;
  do {
    const url = apiUrl(options.baseUrl, "api/conversations");
    if (cursor) url.searchParams.set("cursor", cursor);
    const feed = conversationFeedSchema.parse(
      await fetchJson(url, options.token),
    );
    for (const conversation of feed.conversations) {
      console.log(
        JSON.stringify({
          id: conversation.conversationId,
          title: conversation.displayTitle,
          url: apiUrl(
            options.baseUrl,
            `conversations/${encodeURIComponent(conversation.conversationId)}`,
          ).href,
          slackUrl: conversation.locationUrl ?? null,
        }),
      );
    }
    cursor = feed.nextCursor;
  } while (cursor);
}

/** Run `junior conversations list`. */
export async function runConversations(argv: string[]): Promise<number> {
  try {
    const [subcommand, ...rest] = argv;
    if (subcommand === "list") {
      await listConversations(parseListOptions(rest));
      return 0;
    }
    throw new Error(CLI_USAGE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
