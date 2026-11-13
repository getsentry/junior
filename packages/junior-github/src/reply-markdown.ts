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
const REPO = "[A-Za-z0-9._-]+";
const SHA = "[0-9a-f]{7,40}";
// A reference must not continue a word, path, domain, email, HTML entity,
// escape, or Slack token such as `<@U123>`.
const START = "(?<![\\w.\\-/@&<\\\\])";
const END = "(?![\\w-])";

// Alternatives are ordered so that a qualified reference wins at one position.
const TEXT_REFERENCE_PATTERN = new RegExp(
  [
    `${START}(?<issueOwner>${OWNER})\\/(?<issueRepo>${REPO})#(?<issue>\\d+)${END}`,
    `${START}(?<commitOwner>${OWNER})\\/(?<commitRepo>${REPO})@(?<commit>${SHA})${END}`,
    `${START}(?<user>${OWNER})@(?<userCommit>[0-9a-f]{40})${END}`,
    `${START}(?:#|GH-)(?<bareIssue>\\d+)${END}`,
    // Not `@scope/name`, which is an npm package more often than a team.
    `${START}@(?<mention>${OWNER})(?![\\w/-]|\\.\\w)`,
    // Only full SHAs: shorter hex runs are often other IDs, such as event IDs.
    `${START}(?<bareCommit>[0-9a-f]{40})${END}`,
  ].join("|"),
  "g",
);

// `orgs/` and `enterprises/` paths hold discussions that belong to no repository.
const GITHUB_URL_BODY = `https?:\\/\\/(?:www\\.)?github\\.com\\/(?!(?:orgs|enterprises)\\/)(?<owner>${OWNER})\\/(?<repo>${REPO})\\/(?:(?:issues|pull|discussions)\\/(?<issue>\\d+)|commit\\/(?<commit>${SHA}))`;
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

/**
 * Return the distinct repositories that the text names in qualified
 * references or GitHub issue, pull request, and commit URLs.
 */
function namedRepositories(text: string, spans: Span[]): Repository[] {
  const repositories = new Map<string, Repository>();
  const add = (owner: string | undefined, name: string | undefined) => {
    if (owner && name) {
      repositories.set(`${owner}/${name}`.toLowerCase(), { owner, name });
    }
  };
  for (const span of spans) {
    if (span.url) {
      for (const { groups } of span.url.matchAll(GITHUB_LINKED_URL_PATTERN)) {
        add(groups?.owner, groups?.repo);
      }
    } else {
      const source = text.slice(span.start, span.end);
      for (const { groups } of source.matchAll(TEXT_REFERENCE_PATTERN)) {
        add(groups?.issueOwner, groups?.issueRepo);
        add(groups?.commitOwner, groups?.commitRepo);
      }
    }
  }
  return [...repositories.values()];
}

const issueUrl = (owner: string, name: string, issue: string) =>
  `https://github.com/${owner}/${name}/issues/${issue}`;
const commitUrl = (owner: string, name: string, sha: string) =>
  `https://github.com/${owner}/${name}/commit/${sha}`;

function linkifyUrl(url: string): string {
  const groups = GITHUB_URL_PATTERN.exec(url)?.groups;
  if (!groups?.owner || !groups.repo) {
    return url;
  }
  const label = groups.issue
    ? `${groups.owner}/${groups.repo}#${groups.issue}`
    : `${groups.owner}/${groups.repo}@${groups.commit!.slice(0, 7)}`;
  return `[${label}](${url})`;
}

function linkifyTextReferences(
  text: string,
  context: {
    linkProfiles: boolean;
    mention: (login: string) => string | undefined;
    repository: Repository | undefined;
  },
): string {
  const { repository } = context;
  return text.replace(TEXT_REFERENCE_PATTERN, (reference, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    if (groups.issue) {
      return `[${reference}](${issueUrl(groups.issueOwner!, groups.issueRepo!, groups.issue)})`;
    }
    if (groups.commit) {
      const label = `${groups.commitOwner}/${groups.commitRepo}@${groups.commit.slice(0, 7)}`;
      return `[${label}](${commitUrl(groups.commitOwner!, groups.commitRepo!, groups.commit)})`;
    }
    if (groups.mention) {
      const login = groups.mention;
      if (NON_ACCOUNT_MENTIONS.has(login.toLowerCase())) return reference;
      const known = context.mention(login);
      if (known) return known;
      return context.linkProfiles
        ? `[${reference}](https://github.com/${login})`
        : reference;
    }
    if (!repository) {
      return reference;
    }
    if (groups.bareIssue) {
      return `[${reference}](${issueUrl(repository.owner, repository.name, groups.bareIssue)})`;
    }
    if (groups.userCommit) {
      // `user@sha` names a commit in the user's fork of the repository.
      const label = `${groups.user}@${groups.userCommit.slice(0, 7)}`;
      return `[${label}](${commitUrl(groups.user!, repository.name, groups.userCommit)})`;
    }
    const sha = groups.bareCommit!;
    return `[${sha.slice(0, 7)}](${commitUrl(repository.owner, repository.name, sha)})`;
  });
}

/**
 * Linkify GitHub autolinked references outside Markdown code and links.
 *
 * `owner/repo#123`, `owner/repo@sha`, and GitHub issue, pull request,
 * discussion, and commit URLs always become links. `#123`, `GH-123`,
 * `user@sha`, and full SHAs need a repository: the one that the text names,
 * else the `repo` config value when the text names none. `@login` becomes the
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
  const spans = readSpans(text);
  const named = namedRepositories(text, spans);
  const context = {
    linkProfiles: options.githubText === true || named.length > 0,
    mention: options.mention ?? (() => undefined),
    repository:
      named.length === 0
        ? configuredRepository(options.config ?? {})
        : named.length === 1
          ? named[0]
          : undefined,
  };
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    const source = text.slice(span.start, span.end);
    result += text.slice(cursor, span.start);
    result +=
      span.kind === "text"
        ? linkifyTextReferences(source, context)
        : span.kind === "url" && !options.bareUrls
          ? linkifyUrl(source)
          : source;
    cursor = span.end;
  }
  return result + text.slice(cursor);
}
