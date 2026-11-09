import { Link as LinkIcon } from "lucide-react";
import { useEffect } from "react";
import { Link, useLocation } from "react-router";

import { cn } from "../../styles";

// Space between the sticky chrome and the heading. It also clears the card
// padding above a card heading.
const SCROLL_GAP_PX = 40;

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
  title: string;
}) {
  const { hash, key, search } = useLocation();
  useEffect(() => {
    if (hash !== `#${props.anchor}`) return;
    const heading = document.getElementById(props.anchor);
    if (!heading) return;
    // The sticky chrome covers the top of the page. Its height changes with
    // the header, page links, and banner, so measure it.
    const chrome = document.querySelector("[data-dashboard-chrome]");
    const chromeHeight = chrome?.getBoundingClientRect().height ?? 0;
    heading.style.scrollMarginTop = `${chromeHeight + SCROLL_GAP_PX}px`;
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
        aria-label={`Link to ${props.title}`}
        className="ml-2 inline-flex rounded-sm align-middle text-dashboard-text-muted opacity-0 transition-opacity group-hover/anchor:opacity-100 hover:text-dashboard-text focus-visible:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
        to={{ hash: props.anchor, search }}
      >
        <LinkIcon aria-hidden="true" size={14} />
      </Link>
    </h2>
  );
}
