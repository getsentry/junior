import { Link } from "react-router";
import type {
  WalkthroughChapter,
  WalkthroughVersionResponse,
} from "@sentry/junior/api/schema";

import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { chapterTitle } from "./walkthroughModel";
import type { WalkthroughChangeSummary } from "./walkthroughUpdates";

/**
 * What changed since the reviewer last looked: layers that moved, joined, or
 * left the stack, and links to the chapters that changed.
 */
export function WalkthroughChangeSummaryView(props: {
  chapters: readonly WalkthroughChapter[];
  onOpenChapter(index: number): void;
  summary: WalkthroughChangeSummary;
}) {
  const { summary } = props;
  const prs = (numbers: readonly number[]) =>
    numbers.map((pr) => `#${pr}`).join(", ");
  const layers = [
    summary.movedLayers.length && `New commits: ${prs(summary.movedLayers)}`,
    summary.newLayers.length && `Joined: ${prs(summary.newLayers)}`,
    summary.leftLayers.length &&
      `Left, merged or closed: ${prs(summary.leftLayers.map((l) => l.pr))}`,
  ].filter(Boolean);
  return (
    <section
      aria-label="What changed since you looked"
      className="grid max-w-3xl gap-3 rounded-md border border-amber-300/25 bg-amber-300/5 px-4 py-3"
    >
      <h2 className="m-0 text-sm font-semibold text-dashboard-text">
        What changed since you looked
      </h2>
      {layers.length ? (
        <p className="m-0 text-sm text-dashboard-text-muted">
          {layers.join(" · ")}
        </p>
      ) : null}
      {summary.chapters.length ? (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {summary.chapters.map((entry) => {
            const chapter = props.chapters[entry.index];
            if (!chapter) return null;
            return (
              <li className="grid gap-0.5" key={chapter.id}>
                <button
                  className="w-fit cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-medium text-dashboard-text underline decoration-dashboard-border-emphasis underline-offset-4 hover:decoration-dashboard-text"
                  onClick={() => props.onOpenChapter(entry.index)}
                  type="button"
                >
                  {entry.index + 1}. {chapterTitle(chapter)}
                  {entry.added ? " (new)" : null}
                </button>
                {entry.captions.map((caption) => (
                  <span
                    className="text-sm text-dashboard-text-subtle"
                    key={caption}
                  >
                    <DisplayText inline text={caption} />
                  </span>
                ))}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 text-sm text-dashboard-text-subtle">
          No chapter's code changed.
        </p>
      )}
    </section>
  );
}

/** Links to every version of this Walkthrough, oldest first. */
export function WalkthroughVersions(props: {
  version: WalkthroughVersionResponse;
}) {
  const versions = props.version.versions;
  if (versions.length < 2) return null;
  return (
    <nav
      aria-label="Versions"
      className="inline-flex h-9 items-center gap-0.5 rounded-md border border-dashboard-border-emphasis bg-dashboard-surface-raised px-1 text-sm"
    >
      {versions.map((entry, index) => {
        const current = entry.id === props.version.id;
        const label = `Version ${index + 1}${entry.status === "generating" ? ", writing" : ""}`;
        return (
          <Link
            aria-current={current ? "page" : undefined}
            aria-label={label}
            className={cn(
              "inline-flex h-7 min-w-7 items-center justify-center rounded px-2 tabular-nums no-underline",
              current
                ? "bg-dashboard-fill-strong font-medium text-dashboard-text"
                : "text-dashboard-text-muted hover:bg-dashboard-surface-hover hover:text-dashboard-text",
            )}
            key={entry.id}
            title={label}
            to={`/walkthroughs/${encodeURIComponent(entry.id)}`}
          >
            v{index + 1}
          </Link>
        );
      })}
    </nav>
  );
}
