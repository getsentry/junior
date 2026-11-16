import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";
import { objectPresentation } from "@sentry/junior-plugin-api";
import { useEffect, useState } from "react";
import { ObjectIcon, objectToneClass } from "../components/ObjectIcon";
import { FittingIcons } from "../conversations/ConversationMeta";
import { linkStatusLabel } from "../conversations/ConversationLinkedWork";
import {
  MessageObjectsProvider,
  useResolvedObject,
} from "../display-text/DisplayText";
import { cn } from "../styles";
import type { Conversation } from "../types";

type Annotation = NonNullable<Conversation["sidebarAnnotations"]>[number];
type CardAnnotation = Annotation & {
  objectType: NonNullable<Annotation["objectType"]>;
  title: string;
  url: string;
};

/** Linked work that a comfortable row lists before "+N more". */
export const LINKED_WORK_LIMIT = 4;
/** Linked work that an open or hovered row lists before "+N more". */
export const OPEN_LINKED_WORK_LIMIT = 6;

// Work that needs nothing more ranks last.
const DONE_STATUSES = new Set([
  "archived",
  "canceled",
  "cancelled",
  "closed",
  "completed",
  "done",
  "merged",
  "resolved",
]);

/** Whether an annotation has what a card needs: a type, a title and a URL. */
export function isCard(annotation: Annotation): annotation is CardAnnotation {
  return Boolean(annotation.objectType && annotation.title && annotation.url);
}

/**
 * A row's linked work as saved objects, so the links in its summary show
 * their chips. The feed does not name the owning plugin, so the cards show
 * none.
 */
export function linkedWorkObjects(
  annotations: readonly Annotation[],
): OwnedObjectAnnotation[] {
  return annotations.filter(isCard).map((annotation) => ({
    key: annotation.key,
    kind: "object",
    label: annotation.label,
    objectType: annotation.objectType,
    plugin: "",
    status: annotation.status,
    title: annotation.title,
    url: annotation.url,
  }));
}

/**
 * Rank a row's linked work: its asks' subjects first, then open work, then
 * work that needs nothing more. Each group keeps the saved order, newest
 * first.
 */
export function rankLinkedWork<T extends Annotation>(
  annotations: readonly T[],
  subjects: ReadonlySet<string>,
): T[] {
  const rank = (annotation: T) =>
    annotation.url && subjects.has(annotation.url)
      ? 0
      : annotation.status && DONE_STATUSES.has(annotation.status)
        ? 2
        : 1;
  return [...annotations].sort((a, b) => rank(a) - rank(b));
}

// The owner/repo of a key such as owner/repo#123.
function repoOf(key: string): string | undefined {
  return /^([\w.-]+\/[\w.-]+)#\d+$/.exec(key)?.[1];
}

/** The repo that most of a row's linked work is in. */
export function mainRepo(
  annotations: readonly Annotation[],
): string | undefined {
  const counts = new Map<string, number>();
  let main: string | undefined;
  for (const annotation of annotations) {
    const repo = repoOf(annotation.key);
    if (!repo) continue;
    const count = (counts.get(repo) ?? 0) + 1;
    counts.set(repo, count);
    if (count > (main ? (counts.get(main) ?? 0) : 0)) main = repo;
  }
  return main;
}

/**
 * The short name of a piece of work on its row: #123 in the row's main
 * repo, else repo#123, else its label.
 */
export function workRef(
  work: { key: string; label: string },
  main: string | undefined,
): string {
  const repo = repoOf(work.key);
  if (!repo) return work.label;
  const number = work.key.slice(work.key.lastIndexOf("#"));
  return repo === main
    ? number
    : `${repo.slice(repo.indexOf("/") + 1)}${number}`;
}

/** What one line of linked work names. */
export type WorkLineObject = {
  key: string;
  label: string;
  objectType: OwnedObjectAnnotation["objectType"];
  status?: string | undefined;
  title: string;
};

/**
 * One piece of linked work in one line: its status icon in its status
 * color, its title, then its short name.
 */
export function WorkLine(props: {
  href: string;
  main: string | undefined;
  work: WorkLineObject;
}) {
  const { work } = props;
  const { tone } = objectPresentation(work);
  const ref = workRef(work, props.main);
  return (
    <a
      className="group/card flex min-w-0 items-center gap-1.5 rounded-sm font-sans text-xs no-underline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
      data-linked-work-card=""
      href={props.href}
      rel="noreferrer"
      target="_blank"
      title={[work.title, ref, linkStatusLabel(work.status)]
        .filter(Boolean)
        .join(" · ")}
    >
      <span className="flex shrink-0" data-status-tone={tone}>
        <ObjectIcon
          objectType={work.objectType}
          size={14}
          status={work.status}
        />
      </span>
      <span className="min-w-0 truncate text-dashboard-text group-hover/card:underline">
        {work.title}
      </span>
      {ref === work.title ? null : (
        <span className="shrink-0 tabular-nums text-dashboard-text-faint">
          {ref}
        </span>
      )}
    </a>
  );
}

const WORK_GRID =
  "grid min-w-0 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-4 gap-y-1";

/**
 * Linked work on a comfortable Inbox row, ranked, one line each, up to
 * `limit`. The rest folds into one "+N more" that lists them all. Work that
 * the plugin saved no title or URL for follows in one quiet line.
 */
export function InboxLinkedWork(props: {
  annotations: Annotation[];
  limit: number;
  main: string | undefined;
}) {
  const [all, setAll] = useState(false);
  const cards = props.annotations.filter(isCard);
  const chips = props.annotations.filter((annotation) => !isCard(annotation));
  const shown = all ? cards : cards.slice(0, props.limit);
  const more = cards.length - shown.length;
  return (
    <div aria-label="Linked work" className="grid min-w-0 gap-1" role="group">
      {shown.length > 0 ? (
        <div
          className={cn(
            WORK_GRID,
            // The full list scrolls inside the row, so the row stays short.
            all && "max-h-60 overflow-y-auto overscroll-contain",
          )}
        >
          {shown.map((card) => (
            <WorkLine
              href={card.url}
              key={card.key}
              main={props.main}
              work={card}
            />
          ))}
        </div>
      ) : null}
      {more > 0 || all ? (
        <button
          aria-expanded={all}
          className="justify-self-start rounded-sm text-xs text-dashboard-text-muted hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          data-linked-work-more=""
          onClick={() => setAll(!all)}
          type="button"
        >
          {all ? "Show fewer" : `+${more} more`}
        </button>
      ) : null}
      {chips.length > 0 ? <WorkChipLine annotations={chips} /> : null}
    </div>
  );
}

// The short name of a piece of work, such as #2201 for a pull request.
function shortRef(object: { key: string; label: string }): string {
  const hash = object.key.lastIndexOf("#");
  return hash >= 0 ? object.key.slice(hash) : object.label;
}

// A quiet card in one line: the title, or the label of work saved with no
// title, then the short name in the status color.
function WorkChip(props: { work: Annotation }) {
  const { work } = props;
  const tone = work.objectType
    ? objectPresentation({ objectType: work.objectType, status: work.status })
        .tone
    : undefined;
  const name = work.title ?? work.label;
  const ref = shortRef(work);
  const toneClass = tone ? objectToneClass[tone] : "text-dashboard-text-muted";
  const content =
    ref === name ? (
      <span
        className={cn("truncate tabular-nums", toneClass)}
        data-status-tone={tone}
      >
        {name}
      </span>
    ) : (
      <>
        <span className="truncate text-dashboard-text-muted">{name}</span>
        <span
          className={cn("shrink-0 tabular-nums", toneClass)}
          data-status-tone={tone}
        >
          {ref}
        </span>
      </>
    );
  const className =
    "inline-flex min-w-0 max-w-48 shrink-0 items-baseline gap-1 rounded-sm font-sans text-xs no-underline";
  return work.url ? (
    <a
      className={cn(
        className,
        "hover:underline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
      )}
      data-linked-work-chip=""
      href={work.url}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  ) : (
    <span className={className} data-linked-work-chip="">
      {content}
    </span>
  );
}

// One line of quiet links; those that do not fit become +N.
function WorkChipLine(props: { annotations: Annotation[] }) {
  return (
    <FittingIcons
      // The padding keeps focus rings inside the clipped line.
      className="-m-0.5 h-6 min-w-0 gap-x-2.5 p-0.5"
      icons={props.annotations.map((work) => (
        <WorkChip key={work.key} work={work} />
      ))}
      overflow={(count) => (
        <span
          className="shrink-0 text-2xs text-dashboard-text-faint"
          data-linked-work-overflow=""
        >
          +{count}
        </span>
      )}
    />
  );
}

/**
 * Linked work as one line of quiet links, newest first, each with its
 * title and its short name in its status color. Those that do not fit
 * become +N, so a Conversation with many pull requests keeps one line.
 */
export function InboxLinkedWorkChips(props: { annotations: Annotation[] }) {
  if (props.annotations.length === 0) return null;
  return (
    <span
      aria-label="Linked work"
      // It takes what the pills leave of their line.
      className="flex min-w-32 flex-1 basis-0 items-center gap-1"
      role="group"
    >
      <WorkChipLine annotations={props.annotations} />
    </span>
  );
}

// The objects API checks the viewer's access to each link. A link that
// names no object the viewer can see shows nothing.
function LinkCard(props: { main: string | undefined; url: string }) {
  const { card, request } = useResolvedObject(props.url);
  useEffect(request, [request]);
  if (!card) return null;
  return (
    <WorkLine
      href={card.url ?? props.url}
      main={props.main}
      work={{ ...card, title: card.title ?? card.label }}
    />
  );
}

/** Lines for the web links in a Conversation's recent messages. */
export function InboxLinkCards(props: {
  links: string[];
  main: string | undefined;
}) {
  // One provider per row: the row's links resolve in one request.
  return (
    <MessageObjectsProvider>
      <div
        aria-label="Links"
        className={cn(WORK_GRID, "empty:hidden")}
        role="group"
      >
        {props.links.map((url) => (
          <LinkCard key={url} main={props.main} url={url} />
        ))}
      </div>
    </MessageObjectsProvider>
  );
}
