import type { InboxItemPayload } from "@sentry/junior/api/schema";
import { objectPresentation } from "@sentry/junior-plugin-api";
import { objectToneClass } from "../components/ObjectIcon";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { AskKindIcon } from "./askKind";
import { inboxItemKind } from "./inboxModel";
import { itemNeedsViewer } from "./inboxItemFormat";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";

type Annotation = NonNullable<Conversation["sidebarAnnotations"]>[number];

const PLURALS: Record<string, string> = {
  Approval: "Approvals",
  FYI: "FYIs",
  Question: "Questions",
  "To do for you": "To dos for you",
};

// The kind of a pull request ask in short words, before its change's title.
const PULL_REQUEST_KIND_WORDS: Record<string, string> = {
  "Ready to merge": "Ready to merge",
  "Review requested": "Review",
};

/**
 * One ask pill: what an item asks of the viewer, such as "Question". A pull
 * request ask also names its change, so the change needs no chip of its own.
 */
export type AskPill = {
  count: number;
  key: string;
  kind: string;
  /** The kind in words before `label`, when `label` names something else. */
  kindLabel?: string;
  /** The full name, such as "Review requested #91: Pin the release train". */
  name: string;
  /** The change's number, such as #91, in its status color. */
  ref?: { number: string; tone?: string };
  strong: boolean;
  /** The change's title, or the kind's name for an ask with no change. */
  label?: string;
  /** The change's URL, which its chip would have linked. */
  url?: string;
};

// The change a pull request ask names: its saved linked work when the
// Conversation has it, else the item's own subject.
function askChange(item: InboxItemPayload, annotations: readonly Annotation[]) {
  const url = item.subject.url;
  const work = url
    ? annotations.find((annotation) => annotation.url === url)
    : undefined;
  const subjectTitle = item.subject.object?.title;
  // A subject titled by its key, such as owner/repo#123, adds nothing to #123.
  const title =
    work?.title ??
    (subjectTitle && !/^[\w.-]+\/[\w.-]+#\d+$/.test(subjectTitle)
      ? subjectTitle
      : undefined);
  const tone = work?.objectType
    ? objectToneClass[
        objectPresentation({ objectType: work.objectType, status: work.status })
          .tone
      ]
    : undefined;
  return { title, tone, url };
}

/**
 * Name each open item the way the Inbox does: Question, Approval, the pull
 * request state with its change, or FYI. Repeats fold into a count.
 */
export function askPills(
  items: readonly InboxItemPayload[],
  annotations: readonly Annotation[],
): AskPill[] {
  const pills = new Map<string, AskPill>();
  for (const item of items) {
    if (item.status !== "open") continue;
    const kind = inboxItemKind(item);
    const number = /#\d+/.exec(item.title)?.[0];
    const isPullRequestState =
      kind === "Review requested" || kind === "Ready to merge";
    const key = isPullRequestState && number ? `${kind} ${number}` : kind;
    const current = pills.get(key);
    const strong = (current?.strong ?? false) || itemNeedsViewer(item);
    if (isPullRequestState && number) {
      const change = askChange(item, annotations);
      pills.set(key, {
        count: 1,
        key,
        kind,
        kindLabel: PULL_REQUEST_KIND_WORDS[kind],
        name: change.title ? `${key}: ${change.title}` : key,
        label: change.title,
        ref: { number, tone: change.tone },
        strong,
        url: change.url,
      });
      continue;
    }
    const count = (current?.count ?? 0) + 1;
    const name = count > 1 ? `${count} ${PLURALS[kind] ?? kind}` : kind;
    pills.set(key, {
      count,
      key,
      kind,
      name,
      strong,
      label: name,
    });
  }
  return [...pills.values()].sort(
    (a, b) => Number(b.strong) - Number(a.strong),
  );
}

/**
 * One ask pill: plain text with no fill or frame. The kind shows in words
 * next to its icon, quiet, then what it is about. An ask that waits on the
 * viewer reads in the full text color.
 */
export function Pill(props: { pill: AskPill }) {
  const { pill } = props;
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-0 max-w-60 items-center gap-1 text-xs leading-4 whitespace-nowrap",
        pill.strong ? "text-dashboard-text" : "text-dashboard-text-muted",
      )}
      data-ask-pill={pill.kind}
    >
      <AskKindIcon className="size-3" kind={pill.kind} />
      {pill.kindLabel ? (
        <span className="shrink-0 text-dashboard-text-muted">
          {pill.kindLabel}
        </span>
      ) : null}
      {pill.label ? (
        <span
          className={cn(fadeOverflowClass, "font-medium")}
          ref={fadeWhenOverflowing}
        >
          {pill.label}
        </span>
      ) : null}
      {pill.ref ? (
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            pill.ref.tone ?? "text-dashboard-text-muted",
          )}
        >
          {pill.ref.number}
        </span>
      ) : null}
    </span>
  );
}
