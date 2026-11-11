import { MessagesSquare } from "lucide-react";
import type {
  WalkthroughChapter,
  WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

import { ConversationLinkedWork } from "../conversations/ConversationLinkedWork";
import { DetailsRow } from "../conversations/DetailsList";
import { conversationPath } from "../conversations/conversationRoutes";
import { cn } from "../styles";
import { chapterTitle, typeLabels } from "./walkthroughModel";

const NO_WATCHES = new Map();

const railHeadingClass =
  "m-0 font-sans text-sm font-semibold text-dashboard-text";

/** The pull requests, the Conversation that made them, then the chapters. */
export function WalkthroughRail(props: {
  activeIndex?: number;
  chapters: readonly WalkthroughChapter[];
  onSelect?(index: number): void;
  /** The Conversation that made the PR, when the viewer may read it. */
  sourceConversationId?: string;
  version: WalkthroughVersionResponse;
}) {
  const { version } = props;
  // Layers are stored bottom first. Read the stack top down, like GitHub.
  const links = [...version.codeChanges].reverse().map((change) => ({
    // Same shape as a code change annotation, so the row matches Linked
    // work in the Conversation details panel.
    description: change.title,
    key: `${version.provider}:${change.number}`,
    label: `${version.repository}#${change.number}`,
    objectType: "code_change" as const,
    plugin: version.provider,
    status: "open",
    url: change.url,
  }));

  return (
    <nav
      aria-label="Walkthrough"
      className="thin-scrollbar grid min-h-0 content-start gap-6 overflow-y-auto overscroll-contain border-r border-dashboard-border bg-dashboard-surface-panel px-4 py-5 max-lg:hidden"
    >
      <section className="grid gap-2">
        <h2 className={railHeadingClass}>
          {links.length > 1 ? "Pull requests" : "Pull request"}
        </h2>
        <ConversationLinkedWork links={links} watchesByUrl={NO_WATCHES} />
      </section>
      {props.sourceConversationId ? (
        <section className="grid gap-2">
          <h2 className={railHeadingClass}>Made in</h2>
          <div className="-mx-1.5">
            <DetailsRow
              icon={<MessagesSquare aria-hidden="true" size={14} />}
              title="Conversation"
              to={conversationPath(props.sourceConversationId)}
            />
          </div>
        </section>
      ) : null}
      {props.chapters.length ? (
        <ChapterList
          activeIndex={props.activeIndex}
          chapters={props.chapters}
          onSelect={props.onSelect}
        />
      ) : null}
    </nav>
  );
}

function ChapterList(props: {
  activeIndex?: number;
  chapters: readonly WalkthroughChapter[];
  onSelect?(index: number): void;
}) {
  // A slot can repeat, such as three "The change" chapters. The caption then
  // tells them apart.
  const titleCounts = new Map<string, number>();
  for (const chapter of props.chapters) {
    const title = chapterTitle(chapter);
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return (
    <div className="-mx-1.5 grid gap-3">
      {chapterGroups(props.chapters).map((group) => (
        <div className="grid gap-0.5" key={group.chapters[0]?.index}>
          {group.label ? (
            <h3 className="m-0 px-1.5 pb-0.5 text-xs font-medium text-dashboard-text-faint">
              {group.label}
            </h3>
          ) : null}
          <ol className="m-0 grid list-none gap-0.5 p-0">
            {group.chapters.map(({ chapter, index }) => {
              const active = index === props.activeIndex;
              return (
                <li key={chapter.id}>
                  <button
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex w-full cursor-pointer items-baseline gap-2.5 rounded-md border-0 px-1.5 py-1.5 text-left text-sm",
                      active
                        ? "bg-dashboard-fill-strong text-dashboard-text"
                        : "bg-transparent text-dashboard-text-muted hover:bg-dashboard-surface-hover hover:text-dashboard-text",
                    )}
                    onClick={() => props.onSelect?.(index)}
                    type="button"
                  >
                    <span className="w-4 shrink-0 text-right text-xs tabular-nums text-dashboard-text-faint">
                      {index + 1}
                    </span>
                    <span className="grid min-w-0 gap-0.5">
                      {chapterTitle(chapter)}
                      {(titleCounts.get(chapterTitle(chapter)) ?? 0) > 1 ? (
                        <span className="line-clamp-2 text-xs text-dashboard-text-faint">
                          {chapter.caption}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}

/**
 * Group chapters by change type when a Walkthrough mixes types. A single type
 * needs no heading: the intent line names it once.
 */
function chapterGroups(chapters: readonly WalkthroughChapter[]) {
  const groups: {
    label?: string;
    chapters: { chapter: WalkthroughChapter; index: number }[];
  }[] = [];
  // A ship check is not a type of change, so it does not make a mix, and it
  // stays in the group above it.
  const types = new Set(
    chapters.map((c) => c.type).filter((type) => type !== "ship_check"),
  );
  chapters.forEach((chapter, index) => {
    const last = groups.at(-1);
    const label =
      chapter.type === "ship_check"
        ? last?.label
        : types.size > 1
          ? typeLabels[chapter.type]
          : undefined;
    if (last && last.label === label) last.chapters.push({ chapter, index });
    else groups.push({ label, chapters: [{ chapter, index }] });
  });
  return groups;
}
