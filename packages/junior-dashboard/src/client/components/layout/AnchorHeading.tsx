import { Link as LinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";

import { cn } from "../../styles";

// Space between the sticky chrome and the heading. It also clears the card
// padding above a card heading.
const SCROLL_GAP_PX = 40;

/**
 * How far below the viewport top a followed heading lands: under the sticky
 * chrome, plus a gap. The chrome's height changes with the header, page
 * links, and banner, so measure it.
 */
function anchorScrollMargin(): number {
  const chrome = document.querySelector("[data-dashboard-chrome]");
  return (chrome?.getBoundingClientRect().height ?? 0) + SCROLL_GAP_PX;
}

/**
 * Track which of `anchors` the reader is in: the last heading that has
 * scrolled up to where a followed link puts it, else the first. A hash that
 * names one marks it at once. At the end of the page, where short sections
 * cannot reach that line, the hash's section wins if it shows, else the last.
 */
export function useCurrentAnchor(
  anchors: readonly string[],
): string | undefined {
  const { hash } = useLocation();
  const [current, setCurrent] = useState<string>();
  const ids = anchors.join(" ");
  useEffect(() => {
    if (!ids) return;
    const list = ids.split(" ");
    const target = hash.slice(1);
    let frame = 0;
    let waits = 0;
    // Until the reader or the heading's own scroll moves the page, the
    // hash's section stays marked while it shows: `scrollIntoView` runs
    // after the first frames, and fires no scroll when the heading is
    // already on screen.
    let followed = list.includes(target);
    const update = () => {
      frame = 0;
      const margin = anchorScrollMargin();
      const line = margin + 1;
      const chromeBottom = margin - SCROLL_GAP_PX;
      const page = document.scrollingElement;
      const atEnd =
        page !== null &&
        page.scrollHeight > window.innerHeight &&
        window.scrollY + window.innerHeight >= page.scrollHeight - 2;
      if (followed) {
        const top = document
          .getElementById(target)
          ?.getBoundingClientRect().top;
        if (top === undefined) {
          if (++waits < 60) schedule();
          return;
        }
        if (top >= chromeBottom && top < window.innerHeight) {
          setCurrent(target);
          return;
        }
      }
      let next: string | undefined;
      for (const id of list) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top === undefined) continue;
        if (next === undefined || top <= line) next = id;
        const shows = top >= chromeBottom && top < window.innerHeight;
        if (atEnd && id === target && shows) {
          setCurrent(id);
          return;
        }
        if (atEnd) next = id;
      }
      if (next !== undefined) {
        setCurrent(next);
        return;
      }
      // The headings have not mounted yet. Their mount fires no scroll or
      // resize, so look again on the next frames.
      if (++waits < 60) schedule();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onScroll = () => {
      followed = false;
      schedule();
    };
    // A new page drops the old page's section; the hash's section shows
    // at once, else the first one.
    setCurrent(list.includes(target) ? target : undefined);
    schedule();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", schedule);
    };
  }, [hash, ids]);
  // Before the headings mount, the page opens at its first section.
  return ids ? (current ?? anchors[0]) : undefined;
}

/** Id of the title text, for `aria-labelledby` on the section. */
export function anchorTitleId(anchor: string): string {
  return `${anchor}-title`;
}

/**
 * Render a section heading that people can link to with `#anchor`. The page
 * scrolls to the heading when the URL hash names it.
 */
export function AnchorHeading(props: {
  anchor: string;
  className?: string;
  /** Name the link when the title is a changing value, such as a total. */
  label?: string;
  title: string;
}) {
  const { hash, key, search } = useLocation();
  useEffect(() => {
    if (hash !== `#${props.anchor}`) return;
    const heading = document.getElementById(props.anchor);
    if (!heading) return;
    // The sticky chrome covers the top of the page.
    heading.style.scrollMarginTop = `${anchorScrollMargin()}px`;
    heading.scrollIntoView();
    // `key` changes when someone follows the same anchor again.
  }, [hash, key, props.anchor]);

  const titleId = anchorTitleId(props.anchor);
  return (
    <h2
      aria-labelledby={titleId}
      className={cn("group/anchor", props.className)}
      id={props.anchor}
    >
      <span id={titleId}>{props.title}</span>
      <Link
        aria-label={`Link to ${props.label ?? props.title}`}
        className="ml-2 inline-flex rounded-sm align-middle text-dashboard-text-muted opacity-0 transition-opacity group-hover/anchor:opacity-100 hover:text-dashboard-text focus-visible:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
        to={{ hash: props.anchor, search }}
      >
        <LinkIcon aria-hidden="true" size={14} />
      </Link>
    </h2>
  );
}
