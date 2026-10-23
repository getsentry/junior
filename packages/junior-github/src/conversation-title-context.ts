import type { PluginLogger } from "@sentry/junior-plugin-api";
import { isRecord } from "./credential-support.js";

const GITHUB_OBJECT_URL =
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/gi;
// Name a Conversation from its main objects, not from every link it lists.
const MAX_LINKED_OBJECTS = 3;
const TITLE_MAX_LENGTH = 160;

export interface GitHubObjectLink {
  kind: "issue" | "pull_request";
  name: string;
  number: number;
  owner: string;
}

/** Find distinct GitHub issue and pull request links in message text. */
function parseGitHubObjectLinks(text: string): GitHubObjectLink[] {
  const links = new Map<string, GitHubObjectLink>();
  for (const match of text.matchAll(GITHUB_OBJECT_URL)) {
    const [, owner, name, path, number] = match;
    if (!owner || !name || !path || !number) continue;
    const key = `${owner}/${name}#${number}`.toLowerCase();
    if (links.has(key)) continue;
    links.set(key, {
      kind: path.toLowerCase() === "pull" ? "pull_request" : "issue",
      name,
      number: Number(number),
      owner,
    });
    if (links.size >= MAX_LINKED_OBJECTS) break;
  }
  return [...links.values()];
}

/**
 * Describe linked GitHub issues and pull requests for the title model, as
 * `owner/repo#123: Title`. Links that `loadObject` cannot read are left out.
 */
export async function loadGitHubConversationTitleContext(args: {
  loadObject(link: GitHubObjectLink): Promise<unknown>;
  log: PluginLogger;
  text: string;
}): Promise<string[]> {
  const lines = await Promise.all(
    parseGitHubObjectLinks(args.text).map(async (link) => {
      try {
        const object = await args.loadObject(link);
        const title =
          isRecord(object) && typeof object.title === "string"
            ? object.title.replace(/\s+/g, " ").trim()
            : "";
        if (!title) return undefined;
        return `${link.owner}/${link.name}#${link.number}: ${title.slice(0, TITLE_MAX_LENGTH)}`;
      } catch (error) {
        args.log.warn("github.conversation_title_context.load_failed", {
          "app.github.object_kind": link.kind,
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }),
  );
  return lines.filter((line): line is string => Boolean(line));
}
