/**
 * Automation list CLI.
 *
 * Prints one JSON line in the MCP Automation shape for each Automation that
 * the token owner created. The links come from the API.
 */
import { mcpAutomation } from "@/api/mcp/automation";
import { automationListSchema } from "@/api/schema/automation";
import { apiUrl, fetchJson } from "./api-client";
import { CLI_USAGE, optionValue } from "./run";

const PAGE_SIZE = 100;

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

async function listAutomations(options: ListOptions): Promise<void> {
  // Oldest first, so an Automation created while the command runs lands on a
  // later page and does not shift rows that were already read.
  const printed = new Set<string>();
  for (let page = 1; ; page += 1) {
    const url = apiUrl(options.baseUrl, "api/automations");
    url.searchParams.set("scope", "mine");
    url.searchParams.set("sort", "oldest");
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));
    const list = automationListSchema.parse(
      await fetchJson(url, options.token),
    );
    for (const automation of list.automations) {
      if (printed.has(automation.id)) continue;
      printed.add(automation.id);
      console.log(JSON.stringify(mcpAutomation(automation)));
    }
    // A page past the end returns the last page again, so stop on `total`.
    if (page * PAGE_SIZE >= list.total) return;
  }
}

/** Run `junior automations list`. */
export async function runAutomations(argv: string[]): Promise<number> {
  try {
    const [subcommand, ...rest] = argv;
    if (subcommand === "list") {
      await listAutomations(parseListOptions(rest));
      return 0;
    }
    throw new Error(CLI_USAGE);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
