import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import {
  configuredRepository,
  type Repository,
} from "./configured-repository.js";

// GitHub autolinked references, rendered as Markdown links for chat replies.
// https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
// Enterprise Managed User logins, which can own repositories, end in
// `_shortcode`, such as `ada_acme`.
const LOGIN = `${OWNER}(?:_[A-Za-z0-9]+)?`;
const REPO = "[A-Za-z0-9._-]+";
const SHA = "[0-9a-f]{7,40}";
// A reference must not continue a word, path, domain, email, HTML entity,
// escape, or Slack token such as `<@U123>`.
const START = "(?<![\\w.\\-/@&<\\\\])";
const END = "(?![\\w-])";

// A repository named in prose, such as "all in getsentry/sentry". Only the
// configured owner makes `a/b` a repository, and not a path such as
// `src/index.ts` or a word such as "and/or". A trailing period ends the
// sentence. `owner/repo.git` names `owner/repo`, and an SSH clone URL such
// as `git@github.com:owner/repo` names nothing.
const PROSE_REPOSITORY_PATTERN = new RegExp(
  `(?<![\\w.\\-/@&<\\\\:])(?<owner>${LOGIN})\\/(?<repo>[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)(?<!\\.git)(?![\\w/-])`,
  "g",
);

// Alternatives are ordered so that a qualified reference wins at one position.
const TEXT_REFERENCE_PATTERN = new RegExp(
  [
    `${START}(?<issueOwner>${LOGIN})\\/(?<issueRepo>${REPO})#(?<issue>\\d+)${END}`,
    `${START}(?<commitOwner>${LOGIN})\\/(?<commitRepo>${REPO})@(?<commit>${SHA})${END}`,
    `${START}(?<user>${LOGIN})@(?<userCommit>[0-9a-f]{40})${END}`,
    `${START}(?:#|GH-)(?<bareIssue>\\d+)${END}`,
    // Not `@scope/name`, which is an npm package more often than a team.
    `${START}@(?<mention>${LOGIN})(?![\\w/-]|\\.\\w)`,
    // Only full SHAs: shorter hex runs are often other IDs, such as event IDs.
    `${START}(?<bareCommit>[0-9a-f]{40})${END}`,
  ].join("|"),
  "g",
);

// `orgs/` and `enterprises/` paths hold discussions that belong to no repository.
const GITHUB_URL_BODY = `https?:\\/\\/(?:www\\.)?github\\.com\\/(?!(?:orgs|enterprises)\\/)(?<owner>${LOGIN})\\/(?<repo>${REPO})\\/(?:(?:issues|pull|discussions)\\/(?<issue>\\d+)|commit\\/(?<commit>${SHA}))`;
const GITHUB_URL_PATTERN = new RegExp(`^${GITHUB_URL_BODY}$`, "i");
// A URL anywhere in a link destination.
const GITHUB_LINKED_URL_PATTERN = new RegExp(GITHUB_URL_BODY, "gi");

// Chat words that look like mentions but are no GitHub account.
const NON_ACCOUNT_MENTIONS = new Set(["channel", "everyone", "here"]);

/**
 * A source range that the Markdown parser found: plain text, a bare URL, or
 * a link. Code, HTML, and images get no range, so they stay as written.
 */
interface Span {
  kind: "text" | "url" | "link";
  start: number;
  end: number;
  url?: string;
}

function readSpans(text: string): Span[] {
  const spans: Span[] = [];
  const visit = (node: Nodes) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "text") {
      spans.push({ kind: "text", start, end });
    } else if (node.type === "link" || node.type === "definition") {
      // A GFM autolink literal is the URL itself in the source.
      const bare = node.type === "link" && text.slice(start, end) === node.url;
      spans.push({ kind: bare ? "url" : "link", start, end, url: node.url });
    } else if (node.type !== "linkReference" && "children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(
    fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }),
  );
  return spans;
}

/** A repository that the text names, at its source offset. */
interface NamedRepository {
  offset: number;
  repository: Repository;
}

/**
 * Return the repositories that the text names, in source order: qualified
 * references, GitHub issue, pull request, and commit URLs, and prose that
 * names a repository of the configured owner.
 */
function namedRepositories(
  text: string,
  spans: Span[],
  configuredOwner: string | undefined,
): NamedRepository[] {
  const named: NamedRepository[] = [];
  const add = (
    offset: number,
    owner: string | undefined,
    name: string | undefined,
  ) => {
    if (owner && name) named.push({ offset, repository: { owner, name } });
  };
  for (const span of spans) {
    if (span.url) {
      for (const { groups } of span.url.matchAll(GITHUB_LINKED_URL_PATTERN)) {
        add(span.start, groups?.["owner"], groups?.["repo"]);
      }
      continue;
    }
    const source = text.slice(span.start, span.end);
    for (const { groups, index } of source.matchAll(TEXT_REFERENCE_PATTERN)) {
      const offset = span.start + index;
      add(offset, groups?.["issueOwner"], groups?.["issueRepo"]);
      add(offset, groups?.["commitOwner"], groups?.["commitRepo"]);
    }
    if (!configuredOwner) continue;
    for (const { groups, index } of source.matchAll(PROSE_REPOSITORY_PATTERN)) {
      if (groups?.["owner"]?.toLowerCase() === configuredOwner.toLowerCase()) {
        add(span.start + index, groups["owner"], groups["repo"]);
      }
    }
  }
  return named.sort((left, right) => left.offset - right.offset);
}

const repositoryKey = ({ owner, name }: Repository) =>
  `${owner}/${name}`.toLowerCase();

/**
 * Pick the repository of a bare reference at `offset`: the one repository
 * that the text names, else the last one named before the reference when
 * the text names several, else the configured one when it names none.
 */
function repositoryAt(
  named: NamedRepository[],
  configured: Repository | undefined,
  offset: number,
): Repository | undefined {
  if (named.length === 0) return configured;
  const first = named[0]!.repository;
  if (
    named.every(
      ({ repository }) => repositoryKey(repository) === repositoryKey(first),
    )
  ) {
    return first;
  }
  let nearest: Repository | undefined;
  for (const entry of named) {
    if (entry.offset >= offset) break;
    nearest = entry.repository;
  }
  return nearest;
}

const issueUrl = (owner: string, name: string, issue: string) =>
  `https://github.com/${owner}/${name}/issues/${issue}`;
const commitUrl = (owner: string, name: string, sha: string) =>
  `https://github.com/${owner}/${name}/commit/${sha}`;

function linkifyUrl(url: string): string {
  const groups = GITHUB_URL_PATTERN.exec(url)?.groups;
  if (!groups?.["owner"] || !groups["repo"]) {
    return url;
  }
  const label = groups["issue"]
    ? `${groups["owner"]}/${groups["repo"]}#${groups["issue"]}`
    : `${groups["owner"]}/${groups["repo"]}@${groups["commit"]!.slice(0, 7)}`;
  return `[${label}](${url})`;
}

function linkifyTextReferences(
  text: string,
  start: number,
  context: {
    linkProfiles: boolean;
    mention: (login: string) => string | undefined;
    repositoryAt: (offset: number) => Repository | undefined;
  },
): string {
  return text.replace(TEXT_REFERENCE_PATTERN, (reference, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    // `replace` passes the match offset before the input and the groups.
    const index: unknown = args.at(-3);
    if (groups["issue"]) {
      return `[${reference}](${issueUrl(groups["issueOwner"]!, groups["issueRepo"]!, groups["issue"])})`;
    }
    if (groups["commit"]) {
      const label = `${groups["commitOwner"]}/${groups["commitRepo"]}@${groups["commit"].slice(0, 7)}`;
      return `[${label}](${commitUrl(groups["commitOwner"]!, groups["commitRepo"]!, groups["commit"])})`;
    }
    if (groups["mention"]) {
      const login = groups["mention"];
      if (NON_ACCOUNT_MENTIONS.has(login.toLowerCase())) return reference;
      const known = context.mention(login);
      if (known) return known;
      return context.linkProfiles
        ? `[${reference}](https://github.com/${login})`
        : reference;
    }
    const repository =
      typeof index === "number"
        ? context.repositoryAt(start + index)
        : undefined;
    if (!repository) {
      return reference;
    }
    // The label names the repository, so a reader sees which one a bare
    // reference resolved to.
    const { owner, name } = repository;
    if (groups["bareIssue"]) {
      const issue = groups["bareIssue"];
      return `[${owner}/${name}#${issue}](${issueUrl(owner, name, issue)})`;
    }
    if (groups["userCommit"]) {
      // `user@sha` names a commit in the user's fork of the repository.
      const sha = groups["userCommit"];
      return `[${groups["user"]}/${name}@${sha.slice(0, 7)}](${commitUrl(groups["user"]!, name, sha)})`;
    }
    const sha = groups["bareCommit"]!;
    return `[${owner}/${name}@${sha.slice(0, 7)}](${commitUrl(owner, name, sha)})`;
  });
}

/**
 * Linkify GitHub autolinked references outside Markdown code and links.
 *
 * `owner/repo#123`, `owner/repo@sha`, and GitHub issue, pull request,
 * discussion, and commit URLs always become links. `#123`, `GH-123`,
 * `user@sha`, and full SHAs need a repository: the one that the text names,
 * also as a plain `owner/repo` of the configured owner. When it names
 * several, the last one named before the reference wins. When it names
 * none, the `repo` config value is used. Their link labels name the
 * repository. `@login` becomes the
 * `mention` of the known person with that GitHub login. Other logins become
 * GitHub profile links when the text is GitHub text, or names a repository.
 * Chat `@name` words are often people who are not GitHub accounts. Set
 * `bareUrls` to keep bare URLs, where the place shows them as cards.
 */
export function linkifyGitHubReferences(
  text: string,
  options: {
    bareUrls?: boolean;
    config?: Record<string, string>;
    githubText?: boolean;
    mention?: (login: string) => string | undefined;
  } = {},
): string {
  const config = options.config ?? {};
  const configured = configuredRepository(config);
  const spans = readSpans(text);
  const named = namedRepositories(
    text,
    spans,
    configured?.owner ?? config["org"]?.trim(),
  );
  const context = {
    linkProfiles: options.githubText === true || named.length > 0,
    mention: options.mention ?? (() => undefined),
    repositoryAt: (offset: number) => repositoryAt(named, configured, offset),
  };
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    const source = text.slice(span.start, span.end);
    result += text.slice(cursor, span.start);
    result +=
      span.kind === "text"
        ? linkifyTextReferences(source, span.start, context)
        : span.kind === "url" && !options.bareUrls
          ? linkifyUrl(source)
          : source;
    cursor = span.end;
  }
  return result + text.slice(cursor);
}
