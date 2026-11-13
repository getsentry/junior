import {
  configuredRepository,
  type Repository,
} from "./configured-repository.js";

// GitHub autolinked references, rendered as Markdown links for chat replies.
// https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const REPO = "[A-Za-z0-9._-]+";
const SHA = "[0-9a-f]{7,40}";
// A reference must not continue a word, path, domain, email, or HTML entity.
const START = "(?<![\\w.\\-/@&])";
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
// A whole bare URL, with sentence punctuation after it.
const GITHUB_URL_PATTERN = new RegExp(
  `^${GITHUB_URL_BODY}(?<trailing>[).,;:!?]*)$`,
  "i",
);
// A URL inside an existing link, such as a Markdown link destination.
const GITHUB_LINKED_URL_PATTERN = new RegExp(GITHUB_URL_BODY, "gi");

// Chat words that look like mentions but are no GitHub account.
const NON_ACCOUNT_MENTIONS = new Set(["channel", "everyone", "here"]);

/** A line part. `text` and `url` parts are rewritten; a `link` can name a repository. */
interface Segment {
  kind: "verbatim" | "link" | "url" | "text";
  value: string;
}

function readInlineCode(text: string, start: number): number | undefined {
  if (text[start] !== "`") {
    return undefined;
  }
  let markerLength = 1;
  while (text[start + markerLength] === "`") {
    markerLength++;
  }
  const marker = "`".repeat(markerLength);
  const end = text.indexOf(marker, start + markerLength);
  return end === -1 ? undefined : end + markerLength;
}

/** Read a fenced code opener/closer length of three or more backticks. */
function readFenceLength(line: string): number | undefined {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("```")) {
    return undefined;
  }
  let length = 0;
  while (trimmed[length] === "`") {
    length++;
  }
  return length >= 3 ? length : undefined;
}

/**
 * Skip one existing Markdown link.
 *
 * Labels must not contain brackets or newlines so a bare earlier `[` cannot bind
 * to a later real link. Destinations may be absolute or relative.
 */
function readMarkdownLink(text: string, start: number): number | undefined {
  if (text[start] !== "[") {
    return undefined;
  }

  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd === -1) {
    return undefined;
  }

  const label = text.slice(start + 1, labelEnd);
  if (label.includes("[") || label.includes("]") || label.includes("\n")) {
    return undefined;
  }

  const destStart = labelEnd + 2;
  const closeParens = text.indexOf(")", destStart);
  return closeParens === -1 ? undefined : closeParens + 1;
}

function readAngleToken(text: string, start: number): number | undefined {
  if (text[start] !== "<") {
    return undefined;
  }
  const end = text.indexOf(">", start + 1);
  return end === -1 ? undefined : end + 1;
}

function readUrl(text: string, start: number): number | undefined {
  if (
    !text.startsWith("https://", start) &&
    !text.startsWith("http://", start)
  ) {
    return undefined;
  }
  const match = /^https?:\/\/\S+/.exec(text.slice(start));
  return match ? start + match[0].length : undefined;
}

/** Split one line into parts that must stay as written and parts to scan. */
function segmentLine(line: string): Segment[] {
  const segments: Segment[] = [];
  let text = "";
  const flushText = () => {
    if (text) {
      segments.push({ kind: "text", value: text });
      text = "";
    }
  };

  let index = 0;
  while (index < line.length) {
    const codeEnd = readInlineCode(line, index);
    if (codeEnd !== undefined) {
      flushText();
      segments.push({ kind: "verbatim", value: line.slice(index, codeEnd) });
      index = codeEnd;
      continue;
    }

    const linkEnd =
      readMarkdownLink(line, index) ?? readAngleToken(line, index);
    if (linkEnd !== undefined) {
      flushText();
      segments.push({ kind: "link", value: line.slice(index, linkEnd) });
      index = linkEnd;
      continue;
    }

    const urlEnd = readUrl(line, index);
    if (urlEnd !== undefined) {
      flushText();
      segments.push({ kind: "url", value: line.slice(index, urlEnd) });
      index = urlEnd;
      continue;
    }

    text += line[index];
    index++;
  }
  flushText();
  return segments;
}

/** Split text into lines of segments. Fenced code lines stay verbatim. */
function segmentText(text: string): Segment[][] {
  let openFenceLength = 0;
  return text.split("\n").map((line) => {
    const fenceLength = readFenceLength(line);
    if (fenceLength !== undefined) {
      if (openFenceLength === 0) {
        openFenceLength = fenceLength;
      } else if (fenceLength >= openFenceLength) {
        openFenceLength = 0;
      }
      return [{ kind: "verbatim", value: line }];
    }
    return openFenceLength > 0
      ? [{ kind: "verbatim", value: line }]
      : segmentLine(line);
  });
}

/**
 * Return the distinct repositories that the text names in qualified
 * references or GitHub issue, pull request, and commit URLs.
 */
function namedRepositories(lines: Segment[][]): Repository[] {
  const repositories = new Map<string, Repository>();
  const add = (owner: string | undefined, name: string | undefined) => {
    if (owner && name) {
      repositories.set(`${owner}/${name}`.toLowerCase(), { owner, name });
    }
  };
  for (const segment of lines.flat()) {
    if (segment.kind === "url" || segment.kind === "link") {
      for (const { groups } of segment.value.matchAll(
        GITHUB_LINKED_URL_PATTERN,
      )) {
        add(groups?.owner, groups?.repo);
      }
    } else if (segment.kind === "text") {
      for (const { groups } of segment.value.matchAll(TEXT_REFERENCE_PATTERN)) {
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
  const trailing = groups.trailing ?? "";
  const href = url.slice(0, url.length - trailing.length);
  const label = groups.issue
    ? `${groups.owner}/${groups.repo}#${groups.issue}`
    : `${groups.owner}/${groups.repo}@${groups.commit!.slice(0, 7)}`;
  return `[${label}](${href})${trailing}`;
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
 * GitHub profile links only when the text names a repository, because chat
 * `@name` words are often people who are not GitHub accounts.
 */
export function linkifyGitHubReferences(
  text: string,
  options: {
    config?: Record<string, string>;
    mention?: (login: string) => string | undefined;
  } = {},
): string {
  const lines = segmentText(text);
  const named = namedRepositories(lines);
  const context = {
    linkProfiles: named.length > 0,
    mention: options.mention ?? (() => undefined),
    repository:
      named.length === 0
        ? configuredRepository(options.config ?? {})
        : named.length === 1
          ? named[0]
          : undefined,
  };
  return lines
    .map((segments) =>
      segments
        .map((segment) => {
          if (segment.kind === "url") return linkifyUrl(segment.value);
          if (segment.kind === "text") {
            return linkifyTextReferences(segment.value, context);
          }
          return segment.value;
        })
        .join(""),
    )
    .join("\n");
}
