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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";

type Annotation = NonNullable<Conversation["sidebarAnnotations"]>[number];
type CardAnnotation = Annotation & {
  objectType: NonNullable<Annotation["objectType"]>;
  title: string;
  url: string;
};

/**
 * Linked work of any kind that a comfortable row lists before "+N more".
 */
export const LINKED_WORK_LIMIT = 3;
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

// Whether a label names nothing more than its title. A web page's label is
// its title, maybe with a suffix such as the site name, or its title cut
// short. A title that is only part of a label, such as "123" in ENG-123,
// leaves the label to name the work.
function repeatsTitle(label: string, title: string | undefined): boolean {
  return Boolean(
    title &&
    (label.startsWith(title) || title.startsWith(label.replace(/…$/u, ""))),
  );
}

// The short name of a piece of work on its row: its repo when that is not
// the row's main repo, then #123. Work with no repo, such as a Linear
// issue, has its label, and none when the label repeats its title.
function workRef(
  work: { key: string; label: string; title?: string | undefined },
  main: string | undefined,
): { number?: string | undefined; repo?: string | undefined } {
  const repo = repoOf(work.key);
  if (!repo) {
    return repeatsTitle(work.label, work.title) ? {} : { number: work.label };
  }
  const number = work.key.slice(work.key.lastIndexOf("#"));
  return repo === main
    ? { number }
    : { number, repo: repo.slice(repo.indexOf("/") + 1) };
}

/** What one line of linked work names. */
export type WorkLineObject = {
  key: string;
  label: string;
  objectType?: OwnedObjectAnnotation["objectType"] | undefined;
  status?: string | undefined;
  title?: string | undefined;
};

/**
 * One piece of linked work of any kind in one line: its kind and status
 * icon in its status color, its title, then its short name. Work saved
 * with no title shows its icon and short name. A repo name gives way
 * before the title does. The title truncates next, then the short name, so
 * the line stays in its column. The tooltip names both in full.
 */
export function WorkLine(props: {
  href?: string | undefined;
  main: string | undefined;
  work: WorkLineObject;
}) {
  const { work } = props;
  const tone = work.objectType
    ? objectPresentation({ objectType: work.objectType, status: work.status })
        .tone
    : undefined;
  const ref = workRef(work, props.main);
  const name = work.title && work.title !== ref.number ? work.title : undefined;
  const className =
    "group/card flex min-w-0 items-center gap-1.5 rounded-sm font-sans text-xs no-underline focus-visible:outline-2 focus-visible:outline-dashboard-focus";
  const content = (
    <>
      <span className="flex shrink-0" data-status-tone={tone}>
        {work.objectType ? (
          <ObjectIcon
            objectType={work.objectType}
            size={14}
            status={work.status}
          />
        ) : null}
      </span>
      {/* The short name can take the whole line, so it gives way only
          after the title is gone. Its padding is the gap after the title. */}
      <span className="flex min-w-0 items-center">
        {name ? (
          <span
            className={cn(
              fadeOverflowClass,
              "text-dashboard-text group-hover/card:underline",
            )}
            ref={fadeWhenOverflowing}
          >
            {name}
          </span>
        ) : null}
        {/* The quiet tier: ids and repos are fainter, so the title leads. */}
        {ref.number ? (
          <span
            className={cn(
              "flex max-w-full shrink-0 items-baseline whitespace-nowrap tabular-nums text-dashboard-text-faint",
              name && "pl-1.5",
            )}
          >
            {ref.repo ? (
              <span
                className={cn(fadeOverflowClass, "max-w-24")}
                data-work-repo=""
                ref={fadeWhenOverflowing}
              >
                {ref.repo}
              </span>
            ) : null}
            <span
              className={cn(
                fadeOverflowClass,
                !name && "text-dashboard-text-muted",
              )}
              ref={fadeWhenOverflowing}
            >
              {ref.number}
            </span>
          </span>
        ) : null}
      </span>
    </>
  );
  const title = [
    work.title,
    ref.repo ? `${ref.repo}${ref.number}` : ref.number,
    linkStatusLabel(work.status),
  ]
    .filter(Boolean)
    .join(" · ");
  return props.href ? (
    <a
      className={className}
      data-linked-work-card=""
      href={props.href}
      rel="noreferrer"
      target="_blank"
      title={title}
    >
      {content}
    </a>
  ) : (
    <span className={className} data-linked-work-card="" title={title}>
      {content}
    </span>
  );
}

// Items in a section sit close; sections keep more room between them.
const WORK_GRID =
  "grid min-w-0 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-4 gap-y-0.5";

/**
 * Linked work of every kind on a comfortable Inbox row, ranked, up to
 * `limit`: titled work one line each, then work with no title as ids on
 * one shared line. The rest folds into one "+N more" that lists them all
 * the same way.
 */
export function InboxLinkedWork(props: {
  annotations: Annotation[];
  limit: number;
  main: string | undefined;
}) {
  const [all, setAll] = useState(false);
  const listed = all
    ? props.annotations
    : props.annotations.slice(0, props.limit);
  const shown = listed.filter((annotation) => annotation.title);
  const untitled = listed.filter((annotation) => !annotation.title);
  const more = props.annotations.length - props.limit;
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
          {shown.map((work) => (
            <WorkLine
              href={work.url}
              key={work.key}
              main={props.main}
              work={work}
            />
          ))}
        </div>
      ) : null}
      {untitled.length > 0 ? <WorkChipLine annotations={untitled} /> : null}
      {more > 0 ? (
        <button
          aria-expanded={all}
          className="justify-self-start rounded-sm text-xs text-dashboard-text-faint hover:text-dashboard-text-muted focus-visible:outline-2 focus-visible:outline-dashboard-focus"
          data-linked-work-more=""
          onClick={() => setAll(!all)}
          type="button"
        >
          {all ? "Show fewer" : `+${more} more`}
        </button>
      ) : null}
    </div>
  );
}

// The short name of a piece of work, such as #2201 for a pull request.
function shortRef(object: { key: string; label: string }): string {
  const hash = object.key.lastIndexOf("#");
  return hash >= 0 ? object.key.slice(hash) : object.label;
}

// A quiet chip: the short name in the status color, with the title on
// hover and in the chip's name. Work whose label repeats its title, such
// as a web page, has no short name, so it shows its title.
function WorkChip(props: { work: Annotation }) {
  const { work } = props;
  const tone = work.objectType
    ? objectPresentation({ objectType: work.objectType, status: work.status })
        .tone
    : undefined;
  const name = work.title ?? work.label;
  const ref = shortRef(work);
  const toneClass = tone ? objectToneClass[tone] : "text-dashboard-text-muted";
  const titled = !repeatsTitle(ref, name);
  const content = (
    <>
      {titled ? <span className="sr-only">{name} </span> : null}
      <span
        className={cn(fadeOverflowClass, "tabular-nums", toneClass)}
        data-status-tone={tone}
        ref={fadeWhenOverflowing}
      >
        {titled ? ref : name}
      </span>
    </>
  );
  const className =
    // A chip alone on its line shrinks and truncates its title. It is as
    // tall as an ask pill, so both center on one line.
    "inline-flex h-5 min-w-0 max-w-48 items-center rounded-sm font-sans text-xs no-underline";
  const chip = work.url ? (
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
  if (!titled) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent size="compact">{name}</TooltipContent>
    </Tooltip>
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
          className="shrink-0 text-xs text-dashboard-text-faint"
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
 * short name in its status color and its title on hover. Those that do not fit
 * become +N, so a Conversation with many pull requests keeps one line.
 */
export function InboxLinkedWorkChips(props: { annotations: Annotation[] }) {
  if (props.annotations.length === 0) return null;
  return (
    <span
      aria-label="Linked work"
      // It takes what the pills leave of their line.
      className="flex min-w-20 flex-1 basis-0 items-center gap-1"
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
