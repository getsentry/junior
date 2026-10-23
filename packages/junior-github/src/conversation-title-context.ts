import type { PluginLogger } from "@sentry/junior-plugin-api";
import { isRecord } from "./credential-support.js";

// Name a Conversation from its main objects, not from every reference it has.
const MAX_REFERENCES = 3;
const TITLE_MAX_LENGTH = 160;

const OWNER = String.raw`([A-Za-z0-9][A-Za-z0-9-]*)`;
const REPO = String.raw`([\w.-]*\w)`;
const SHA = String.raw`([0-9a-f]{7,40})`;
const NOT_AFTER_PATH = String.raw`(?<![\w/.-])`;
const REPO_IN_PROSE = String.raw`(?:on|in|from|of|at)\s+${OWNER}\/${REPO}`;

export interface GitHubReference {
  /** Issue number, pull request number, or commit SHA. */
  id: string;
  /** `issue` also matches pull requests, as GitHub numbers them together. */
  kind: "commit" | "issue" | "pull_request";
  name: string;
  owner: string;
}

interface Repository {
  name: string;
  owner: string;
}

interface ReferenceMatch {
  end: number;
  id: string;
  kind: GitHubReference["kind"];
  repository?: Repository;
  start: number;
}

type ReferencePattern = {
  pattern: RegExp;
  read(match: RegExpMatchArray): Omit<ReferenceMatch, "end" | "start">;
};

const repository = (owner?: string, name?: string): Repository | undefined =>
  owner && name ? { owner, name } : undefined;

// GitHub autolinked references, plus prose such as "issue 12 on owner/repo".
// https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
const REFERENCE_PATTERNS: ReferencePattern[] = [
  {
    pattern: new RegExp(
      String.raw`https?:\/\/(?:www\.)?github\.com\/${OWNER}\/${REPO}\/(issues|pull)\/(\d+)`,
      "gi",
    ),
    read: ([, owner, name, path, id]) => ({
      id: id!,
      kind: path!.toLowerCase() === "pull" ? "pull_request" : "issue",
      repository: repository(owner, name),
    }),
  },
  {
    pattern: new RegExp(
      String.raw`https?:\/\/(?:www\.)?github\.com\/${OWNER}\/${REPO}\/commit\/${SHA}`,
      "gi",
    ),
    read: ([, owner, name, id]) => ({
      id: id!,
      kind: "commit",
      repository: repository(owner, name),
    }),
  },
  {
    pattern: new RegExp(
      String.raw`${NOT_AFTER_PATH}${OWNER}\/${REPO}#(\d+)\b`,
      "g",
    ),
    read: ([, owner, name, id]) => ({
      id: id!,
      kind: "issue",
      repository: repository(owner, name),
    }),
  },
  {
    pattern: new RegExp(
      String.raw`${NOT_AFTER_PATH}${OWNER}\/${REPO}@${SHA}\b`,
      "g",
    ),
    read: ([, owner, name, id]) => ({
      id: id!,
      kind: "commit",
      repository: repository(owner, name),
    }),
  },
  {
    pattern: new RegExp(
      String.raw`\b(issues?|bugs?|tickets?|prs?|pulls?|pull requests?)\s+(?:#|no\.?\s*|number\s+)?(\d+)\b(?:\s+${REPO_IN_PROSE})?`,
      "gi",
    ),
    read: ([, noun, id, owner, name]) => ({
      id: id!,
      kind: /^(?:prs?|pulls?|pull requests?)$/i.test(noun!)
        ? "pull_request"
        : "issue",
      repository: repository(owner, name),
    }),
  },
  {
    pattern: /(?<![\w/&])(?:#|\bGH-)(\d+)\b/gi,
    read: ([, id]) => ({ id: id!, kind: "issue" }),
  },
];

/** Read `repo` as `owner/name`, or as `name` with the `org` config value. */
function configuredRepository(
  config: Record<string, string>,
): Repository | undefined {
  const [first, second, ...extra] = (config.repo ?? "").trim().split("/");
  if (extra.length > 0) return undefined;
  return second
    ? repository(first, second)
    : repository(config.org?.trim(), first);
}

/**
 * Find distinct GitHub references in message text, in message order.
 * A reference without a repository uses the one repository that the message
 * names, or else the configured repository.
 */
function parseGitHubReferences(
  text: string,
  config: Record<string, string>,
): GitHubReference[] {
  const matches = REFERENCE_PATTERNS.flatMap(({ pattern, read }) =>
    [...text.matchAll(pattern)].map((match) => ({
      ...read(match),
      end: match.index + match[0].length,
      start: match.index,
    })),
  ).sort((left, right) => left.start - right.start || right.end - left.end);

  const accepted: ReferenceMatch[] = [];
  for (const match of matches) {
    const previous = accepted.at(-1);
    if (!previous || match.start >= previous.end) accepted.push(match);
  }

  const namedRepositories = new Map<string, Repository>();
  for (const match of accepted) {
    if (match.repository) {
      const key = `${match.repository.owner}/${match.repository.name}`;
      namedRepositories.set(key.toLowerCase(), match.repository);
    }
  }
  for (const match of text.matchAll(new RegExp(REPO_IN_PROSE, "gi"))) {
    const named = repository(match[1], match[2]);
    if (named) {
      namedRepositories.set(
        `${named.owner}/${named.name}`.toLowerCase(),
        named,
      );
    }
  }
  const fallback =
    namedRepositories.size === 1
      ? [...namedRepositories.values()][0]
      : configuredRepository(config);

  const references = new Map<string, GitHubReference>();
  for (const match of accepted) {
    const target = match.repository ?? fallback;
    if (!target) continue;
    const key =
      `${target.owner}/${target.name}${match.kind === "commit" ? "@" : "#"}${match.id}`.toLowerCase();
    if (references.has(key)) continue;
    references.set(key, { ...target, id: match.id, kind: match.kind });
    if (references.size >= MAX_REFERENCES) break;
  }
  return [...references.values()];
}

/** Read the display title of an issue, pull request, or commit response. */
function objectTitle(
  kind: GitHubReference["kind"],
  object: unknown,
): string | undefined {
  if (!isRecord(object)) return undefined;
  const raw =
    kind === "commit"
      ? isRecord(object.commit) && typeof object.commit.message === "string"
        ? object.commit.message.split("\n")[0]
        : undefined
      : typeof object.title === "string"
        ? object.title
        : undefined;
  return raw?.replace(/\s+/g, " ").trim() || undefined;
}

/**
 * Describe GitHub issues, pull requests, and commits that message text
 * references, as `owner/repo#123: Title` or `owner/repo@abc1234: Subject`.
 * References that `loadObject` cannot read are left out.
 */
export async function loadGitHubConversationTitleContext(args: {
  config: Record<string, string>;
  loadObject(reference: GitHubReference): Promise<unknown>;
  log: PluginLogger;
  text: string;
}): Promise<string[]> {
  const lines = await Promise.all(
    parseGitHubReferences(args.text, args.config).map(async (reference) => {
      try {
        const title = objectTitle(
          reference.kind,
          await args.loadObject(reference),
        );
        if (!title) return undefined;
        const label =
          reference.kind === "commit"
            ? `${reference.owner}/${reference.name}@${reference.id.slice(0, 7)}`
            : `${reference.owner}/${reference.name}#${reference.id}`;
        return `${label}: ${title.slice(0, TITLE_MAX_LENGTH)}`;
      } catch (error) {
        args.log.warn("github.conversation_title_context.load_failed", {
          "app.github.object_kind": reference.kind,
          "exception.message":
            error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }),
  );
  return lines.filter((line): line is string => Boolean(line));
}
