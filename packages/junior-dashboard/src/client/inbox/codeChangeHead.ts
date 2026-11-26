import type { InboxItemPayload } from "@sentry/junior/api/schema";
import type { ObjectFacts } from "@sentry/junior-plugin-api";

import type { Conversation } from "../types";

/**
 * The head of an Inbox row for one code change item, as "Review requested ·
 * #91" about "feat(api): Pin the release train". The title leads; the state
 * and the change's reference become short words around it.
 */
export type CodeChangeHead = {
  /** The label of the item's subject kind, such as "Review requested". */
  kind: string;
  /** The state in one word, such as "Review". */
  state: string;
  /** The change's reference, such as "payments#91". */
  reference: string;
  /** The title without its type prefix, with its type, scope and breaking mark. */
  title: CodeChangeTitleParts;
  /** The change's page on its provider. */
  url: string;
  /** Name of the action that opens `url`, such as "Review on GitHub". */
  openLabel: string;
  /** The open action's short label, such as "Review". */
  openText: string;
  /** Whether `url` is on github.com, so the open action shows its mark. */
  onGitHub: boolean;
};

type CodeChangeTitleParts = NonNullable<
  Extract<ObjectFacts, { type: "code_change" }>["titleParts"]
>;

// The number part of a code change key such as "getsentry/payments#91".
const KEY_NUMBER = /(#\d+)$/;

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
 * another item, which keeps its own title. The state is the label of the
 * subject kind, and the title is the change's title now, from its card.
 */
export function codeChangeHead(
  item: Pick<InboxItemPayload, "status" | "subject">,
  conversation: Pick<Conversation, "sidebarAnnotations"> | undefined,
): CodeChangeHead | undefined {
  const { label: kind, object, url } = item.subject;
  const number = object && KEY_NUMBER.exec(object.key)?.[1];
  if (
    item.status !== "open" ||
    !kind ||
    !url ||
    object?.objectType !== "code_change" ||
    !object.title ||
    !number
  ) {
    return undefined;
  }
  const host = hostName(url);
  if (!host) return undefined;
  const repo = shortRepo(url, conversation);
  const openText = kind === "Review requested" ? "Review" : "Open";
  return {
    kind,
    onGitHub: host === "GitHub",
    openLabel: `${openText} on ${host}`,
    openText,
    reference: repo ? `${repo}${number}` : number,
    state: STATE_WORDS[kind] ?? kind,
    title: (object.facts?.type === "code_change"
      ? object.facts.titleParts
      : undefined) ?? { text: object.title.replace(REFERENCE_TAIL, "") },
    url,
  };
}
