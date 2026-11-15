import { Link as LinkIcon } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";

import { cn } from "../../styles";

// Space between the sticky chrome and the heading. It also clears the card
// padding above a card heading, which is in rem, so this is in rem too.
const SCROLL_GAP = "2.5rem";

// Input that means the reader moves the page themselves.
const READER_INPUT = ["keydown", "pointerdown", "touchstart", "wheel"] as const;

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
    // Where the heading sat after the last scroll, and the page height then.
    let settled = { height: 0, top: 0 };
    const scroll = () => {
      // The sticky chrome covers the top of the page. Its height changes with
      // the header, page links, and banner, so measure it.
      const chrome = document.querySelector("[data-dashboard-chrome]");
      const chromeHeight = chrome?.getBoundingClientRect().height ?? 0;
      heading.style.scrollMarginTop = `calc(${chromeHeight}px + ${SCROLL_GAP})`;
      heading.scrollIntoView();
      settled = {
        height: document.body.offsetHeight,
        top: heading.getBoundingClientRect().top,
      };
    };
    scroll();
    // Sections above can still load and grow, which pushes the heading down.
    // Keep it in view until the reader takes over.
    const observer = new ResizeObserver(scroll);
    observer.observe(document.body);
    const stop = () => observer.disconnect();
    // A scroll at the same page height moved the heading, so the reader
    // scrolled, for example with the scrollbar. After growth, the observer
    // scrolls back.
    const onScroll = () => {
      if (document.body.offsetHeight !== settled.height) return;
      if (Math.abs(heading.getBoundingClientRect().top - settled.top) > 1) {
        stop();
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    for (const type of READER_INPUT) {
      window.addEventListener(type, stop, { passive: true });
    }
    return () => {
      stop();
      window.removeEventListener("scroll", onScroll);
      for (const type of READER_INPUT) window.removeEventListener(type, stop);
    };
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
