import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Link, NavLink, useLocation } from "react-router";

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

/** Link to a sibling page and keep page filters (range, scope, q). */
export function SiblingPageLink(props: {
  className: (state: { isActive: boolean }) => string;
  item: SegmentedNavItem;
}) {
  const { className, item } = props;
  const location = useLocation();
  const to = pathWithSearch(item.to, location.search);
  if (item.isActive) {
    const isActive = item.isActive(location.pathname);
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

/** Scroll the current page link into view when the row clips it. */
function revealCurrentLink(row: HTMLElement) {
  const link = row.querySelector<HTMLElement>('[aria-current="page"]');
  if (!link || row.clientWidth === 0) return;
  const start = link.offsetLeft;
  const end = start + link.offsetWidth;
  if (start >= row.scrollLeft && end <= row.scrollLeft + row.clientWidth) {
    return;
  }
  // scrollIntoView can also scroll the page, so set scrollLeft on the row.
  row.scrollLeft = start - (row.clientWidth - link.offsetWidth) / 2;
}

type HiddenEdges = { end: boolean; start: boolean };

/** Fade each edge of the row that hides more links. */
function edgeFade(edges: HiddenEdges): CSSProperties | undefined {
  if (!edges.start && !edges.end) return undefined;
  const start = edges.start ? "transparent, black 1.5rem" : "black";
  const end = edges.end ? "black calc(100% - 1.5rem), transparent" : "black";
  const mask = `linear-gradient(to right, ${start}, ${end})`;
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * Show links between sibling pages in the segmented pill track.
 *
 * With `fill`, links share the row width equally while their labels fit.
 * Otherwise each link keeps its label width. When the links do not fit, the
 * row scrolls sideways and fades the edge that hides more links.
 */
export function SegmentedNav(props: {
  ariaLabel: string;
  fill?: boolean;
  items: readonly SegmentedNavItem[];
}) {
  const { pathname } = useLocation();
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<HiddenEdges>({
    end: false,
    start: false,
  });

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const updateEdges = () => {
      const maxScroll = row.scrollWidth - row.clientWidth;
      const start = row.scrollLeft > 1;
      const end = row.scrollLeft < maxScroll - 1;
      setEdges((previous) =>
        previous.start === start && previous.end === end
          ? previous
          : { end, start },
      );
    };
    // A row hidden at this breakpoint has no width. Reveal the current link
    // when it gets one.
    const observer = new ResizeObserver(() => {
      revealCurrentLink(row);
      updateEdges();
    });
    updateEdges();
    row.addEventListener("scroll", updateEdges, { passive: true });
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", updateEdges);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (rowRef.current) revealCurrentLink(rowRef.current);
  }, [pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      segmentedTabClass(isActive),
      "flex items-center justify-center whitespace-nowrap no-underline",
      props.fill ? "min-w-max flex-[1_0_0]" : "shrink-0",
    );

  return (
    <nav
      aria-label={props.ariaLabel}
      className={cn(
        segmentedTabsFrameClass,
        "flex min-w-0 max-w-full",
        !props.fill && "w-fit",
      )}
    >
      {/* Pad the scrolling row, not the frame, so the last link keeps its
          padding when the row is scrolled to the end. */}
      <div
        className={cn(
          segmentedTabsInsetClass,
          "relative flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        ref={rowRef}
        style={edgeFade(edges)}
      >
        {props.items.map((item) => (
          <SiblingPageLink className={linkClass} item={item} key={item.to} />
        ))}
      </div>
    </nav>
  );
}
