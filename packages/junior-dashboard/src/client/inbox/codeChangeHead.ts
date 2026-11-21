import type { ReviewItemPayload } from "@sentry/junior/api/schema";
import type { ReviewItemSubjectTitleParts } from "@sentry/junior-plugin-api";

import type { Conversation } from "../types";

/**
 * The head of an Inbox row for one code change item, as "Review requested ·
 * #91" about "feat(api): Pin the release train". The title leads; the state
 * and the change's reference become short words around it.
 */
export type CodeChangeHead = {
  /** The plugin's name of the state, such as "Review requested". */
  kind: string;
  /** The state in one word, such as "Review". */
  state: string;
  /** The change's reference, such as "payments#91". */
  reference: string;
  /** The title without its type prefix, with its type, scope and breaking mark. */
  title: ReviewItemSubjectTitleParts;
  /** The change's page on its provider. */
  url: string;
  /** Name of the action that opens `url`, such as "Review on GitHub". */
  openLabel: string;
};

// The plugin titles each pull request item "<state> · #<number>"
// (`junior-github` `showAction` and the merge conflict check).
const STATE_TITLE = /^(.+) · (#\d+)$/;

const STATE_WORDS: Record<string, string> = {
  "Merge conflict": "Conflict",
  "Ready to merge": "Merge",
  "Review requested": "Review",
};

// A subject title that ends with its reference, as "Fix it (#12)".
const REFERENCE_TAIL = /\s+\(#\d+\)$/;

function hostName(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const { hostname } = new URL(url);
  return hostname === "github.com" ? "GitHub" : hostname;
}

// The repo part of a linked work key such as "getsentry/payments#91".
function shortRepo(
  url: string,
  conversation: Pick<Conversation, "sidebarAnnotations"> | undefined,
): string | undefined {
  const key = conversation?.sidebarAnnotations?.find(
    (annotation) => annotation.url === url,
  )?.key;
  return key ? /^[\w.-]+\/([\w.-]+)#\d+$/.exec(key)?.[1] : undefined;
}

/**
 * The head of a row for one item about a code change, or undefined for
 * another item, which keeps its own title.
 */
export function codeChangeHead(
  item: Pick<ReviewItemPayload, "status" | "subject" | "title">,
  conversation: Pick<Conversation, "sidebarAnnotations"> | undefined,
): CodeChangeHead | undefined {
  const subject = item.subject;
  const match = STATE_TITLE.exec(item.title);
  if (
    item.status !== "open" ||
    subject?.objectType !== "code_change" ||
    !subject.url ||
    !subject.title ||
    !match
  ) {
    return undefined;
  }
  const kind = match[1]!;
  const number = match[2]!;
  const host = hostName(subject.url);
  if (!host) return undefined;
  const repo = shortRepo(subject.url, conversation);
  return {
    kind,
    openLabel: `${kind === "Review requested" ? "Review" : "Open"} on ${host}`,
    reference: repo ? `${repo}${number}` : number,
    state: STATE_WORDS[kind] ?? kind,
    title: subject.titleParts ?? {
      text: subject.title.replace(REFERENCE_TAIL, ""),
    },
    url: subject.url,
  };
}
