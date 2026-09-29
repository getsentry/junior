import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Link, NavLink } from "react-router";

import { pathWithSearch } from "../searchParams";
import {
  segmentedTabClass,
  segmentedTabsFrameClass,
  segmentedTabsInsetClass,
} from "./SegmentedTabs";
import { cn } from "../styles";

export type SegmentedNavItem = {
  end?: boolean;
  /** Override default NavLink matching when a path family should stay active. */
  isActive?: (pathname: string) => boolean;
  label: string;
  to: string;
};

type LinkClassState = { isActive: boolean };

function SegmentedNavLink(props: {
  className: (state: LinkClassState) => string;
  item: SegmentedNavItem;
  pathname: string;
  search?: string;
}) {
  const { className, item, pathname, search } = props;
  const to = search === undefined ? item.to : pathWithSearch(item.to, search);
  if (item.isActive) {
    const isActive = item.isActive(pathname);
    return (
      <Link
        aria-current={isActive ? "page" : undefined}
        className={className({ isActive })}
        to={to}
      >
        {item.label}
      </Link>
    );
  }

  return (
    <NavLink className={className} end={item.end} to={to}>
      {item.label}
    </NavLink>
  );
}

type OverflowEdges = { end: boolean; start: boolean };

/** Scroll the current page link into view if the scroller clips it. */
function revealCurrentLink(scroller: HTMLElement) {
  const link = scroller.querySelector<HTMLElement>('[aria-current="page"]');
  if (!link || scroller.clientWidth === 0) return;
  const start = link.offsetLeft;
  const end = start + link.offsetWidth;
  if (
    start >= scroller.scrollLeft &&
    end <= scroller.scrollLeft + scroller.clientWidth
  ) {
    return;
  }
  // offsetLeft is relative to the scroller, which is positioned. Set
  // scrollLeft directly. scrollIntoView can also scroll the page.
  scroller.scrollLeft = start - (scroller.clientWidth - link.offsetWidth) / 2;
}

/**
 * Track which edges of a horizontal scroller hide content, and keep the
 * current page link in view when the route or the scroller width changes.
 */
function useSegmentedNavScroller(pathname: string) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<OverflowEdges>({
    end: false,
    start: false,
  });

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const update = () => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      const start = scroller.scrollLeft > 1;
      const end = scroller.scrollLeft < maxScroll - 1;
      setEdges((previous) =>
        previous.start === start && previous.end === end
          ? previous
          : { end, start },
      );
    };
    // A hidden row (for example the mobile row on desktop) has no width.
    // Reveal the current link once it gets one.
    const resize = () => {
      revealCurrentLink(scroller);
      update();
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (scrollerRef.current) revealCurrentLink(scrollerRef.current);
  }, [pathname]);

  return { edges, scrollerRef };
}

const EDGE_FADE = "1.5rem";

/** Fade the scroller edges that hide more links. */
function edgeFadeStyle(edges: OverflowEdges): CSSProperties | undefined {
  if (!edges.start && !edges.end) return undefined;
  const mask = `linear-gradient(to right, ${
    edges.start ? `transparent, black ${EDGE_FADE}` : "black"
  }, ${edges.end ? `black calc(100% - ${EDGE_FADE}), transparent` : "black"})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * Link between sibling pages with the segmented pill track.
 *
 * Looks like `SegmentedTabs`, but renders links with `aria-current` instead of
 * a tablist. With `fill`, links share the width equally while their labels fit.
 * Otherwise each link keeps its label width. The row scrolls sideways when the
 * links overflow and fades the edge that hides more links.
 */
export function SegmentedNav(props: {
  ariaLabel: string;
  className?: string;
  fill?: boolean;
  items: readonly SegmentedNavItem[];
  pathname: string;
  /** Carry page filters (range, scope, q) across sibling pages. */
  search?: string;
}) {
  const { edges, scrollerRef } = useSegmentedNavScroller(props.pathname);
  const linkClass = ({ isActive }: LinkClassState) =>
    cn(
      segmentedTabClass(isActive),
      "flex items-center justify-center whitespace-nowrap no-underline",
      // Equal shares while labels fit, then label width and sideways scroll.
      props.fill ? "min-w-max flex-[1_0_0]" : "shrink-0",
    );

  return (
    <nav
      aria-label={props.ariaLabel}
      className={cn(
        segmentedTabsFrameClass,
        "min-w-0 max-w-full",
        // Without fill the track hugs its links, even inside grid or flex parents.
        props.fill ? "flex" : "flex w-fit",
        props.className,
      )}
    >
      <div
        // The inset lives on the scroller so the last link keeps its padding
        // when the row is scrolled to the end.
        className={cn(
          segmentedTabsInsetClass,
          "relative flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        data-overflow-end={edges.end || undefined}
        data-overflow-start={edges.start || undefined}
        ref={scrollerRef}
        style={edgeFadeStyle(edges)}
      >
        {props.items.map((item) => (
          <SegmentedNavLink
            className={linkClass}
            item={item}
            key={`${item.to}:${item.label}`}
            pathname={props.pathname}
            search={props.search}
          />
        ))}
      </div>
    </nav>
  );
}
