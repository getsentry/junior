import type { WalkthroughChapter } from "@sentry/junior/api/schema";

import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { chapterSlotLabel, chapterTitle, typeLabels } from "./walkthroughModel";

/** How a chapter differs from what the reviewer last saw. */
export type ChapterMark = "changed" | "new";

/**
 * The chapters, and nothing else. Pull requests and the source Conversation
 * sit in one line under the title, so the story gets the space.
 */
export function WalkthroughRail(props: {
  activeIndex?: number;
  chapters: readonly WalkthroughChapter[];
  /** Chapters that changed or were added since the reviewer looked. */
  marks?: ReadonlyMap<string, ChapterMark>;
  onSelect?(index: number): void;
}) {
  return (
    <nav
      aria-label="Chapters"
      className="thin-scrollbar grid min-h-0 content-start overflow-y-auto overscroll-contain border-r border-dashboard-border bg-dashboard-surface-panel px-4 py-5 max-lg:hidden"
    >
      {props.chapters.length ? (
        <ChapterList
          activeIndex={props.activeIndex}
          chapters={props.chapters}
          marks={props.marks}
          onSelect={props.onSelect}
        />
      ) : null}
    </nav>
  );
}

function ChapterList(props: {
  activeIndex?: number;
  chapters: readonly WalkthroughChapter[];
  marks?: ReadonlyMap<string, ChapterMark>;
  onSelect?(index: number): void;
}) {
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
              const mark = props.marks?.get(chapter.id);
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
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="text-xs text-dashboard-text-faint">
                        {chapterSlotLabel(chapter)}
                      </span>
                      <span className="line-clamp-2">
                        <DisplayText
                          inline
                          links={false}
                          text={chapterTitle(chapter)}
                        />
                      </span>
                    </span>
                    {mark ? (
                      <span className="shrink-0 text-xs text-amber-200">
                        {mark === "new" ? "New" : "Changed"}
                      </span>
                    ) : null}
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
