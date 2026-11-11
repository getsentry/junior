import type { WalkthroughChapter } from "@sentry/junior/api/schema";

import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { chapterTitle } from "./walkthroughModel";

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

/**
 * One story, so one list in reading order. Each row shows the whole title
 * and caption: they wrap instead of being cut.
 */
function ChapterList(props: {
  activeIndex?: number;
  chapters: readonly WalkthroughChapter[];
  marks?: ReadonlyMap<string, ChapterMark>;
  onSelect?(index: number): void;
}) {
  return (
    <ol className="-mx-1.5 m-0 grid list-none gap-0.5 p-0">
      {props.chapters.map((chapter, index) => {
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
              <span className="grid min-w-0 flex-1 gap-0.5 break-words">
                <span className="font-medium">
                  <DisplayText
                    inline
                    links={false}
                    text={chapterTitle(chapter)}
                  />
                </span>
                <span className="text-xs leading-relaxed text-dashboard-text-faint">
                  <DisplayText inline links={false} text={chapter.caption} />
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
  );
}
