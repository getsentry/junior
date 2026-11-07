/**
 * Conversation list CLI.
 *
 * Prints one JSON line in the MCP Conversation shape for each root
 * Conversation of the token owner, and one line for each of its visible
 * Threads after the root. The links come from the API, so the CLI never
 * builds dashboard paths.
 */
import { mcpConversation } from "@/api/mcp/conversation-summary";
import {
  conversationFeedSchema,
  type ConversationFeedItem,
} from "@/api/schema/conversation";
import { apiUrl, fetchJson } from "./api-client";
import { CLI_USAGE, optionValue } from "./run";

type ListOptions = {
  baseUrl: string;
  status: "active" | "archived";
  token: string;
};

function parseListOptions(argv: string[]): ListOptions {
  let baseUrl: string | undefined;
  let status: ListOptions["status"] = "active";
  let token = process.env.JUNIOR_API_TOKEN?.trim();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--base-url") {
      baseUrl = optionValue(argv, index, argument);
      index += 1;
    } else if (argument === "--status") {
      const value = optionValue(argv, index, argument);
      if (value !== "active" && value !== "archived") {
        throw new Error("--status must be active or archived");
      }
      status = value;
      index += 1;
    } else if (argument === "--token") {
      token = optionValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!baseUrl || !token) throw new Error(CLI_USAGE);
  return { baseUrl, status, token };
}

/** Yield a feed row, then its nested Threads depth-first. */
function* feedRows(
  item: ConversationFeedItem,
): Generator<ConversationFeedItem> {
  yield item;
  for (const thread of item.threads ?? []) yield* feedRows(thread);
}

async function listConversations(options: ListOptions): Promise<void> {
  // The first page adds roots that wait on the viewer, and those roots can
  // show again on a later page.
  const printed = new Set<string>();
  let cursor: string | undefined;
  do {
    const url = apiUrl(options.baseUrl, "api/conversations");
    url.searchParams.set("status", options.status);
    if (cursor) url.searchParams.set("cursor", cursor);
    const feed = conversationFeedSchema.parse(
      await fetchJson(url, options.token),
    );
    for (const root of feed.conversations) {
      for (const row of feedRows(root)) {
        if (printed.has(row.conversationId)) continue;
        printed.add(row.conversationId);
        console.log(JSON.stringify(mcpConversation(row)));
      }
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
