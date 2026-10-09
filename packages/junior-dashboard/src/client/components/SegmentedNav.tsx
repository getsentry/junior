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

/** Width of the fade on an edge that hides more links. */
const EDGE_FADE_PX = 24;

type HiddenEdges = { end: boolean; start: boolean };

function hiddenEdges(row: HTMLElement): HiddenEdges {
  const maxScroll = row.scrollWidth - row.clientWidth;
  return {
    end: row.scrollLeft < maxScroll - 1,
    start: row.scrollLeft > 1,
  };
}

/** Scroll the current page link into view when the row or a fade covers it. */
function revealCurrentLink(row: HTMLElement) {
  const link = row.querySelector<HTMLElement>('[aria-current="page"]');
  if (!link || row.clientWidth === 0) return;
  const edges = hiddenEdges(row);
  const visibleStart = row.scrollLeft + (edges.start ? EDGE_FADE_PX : 0);
  const visibleEnd =
    row.scrollLeft + row.clientWidth - (edges.end ? EDGE_FADE_PX : 0);
  const start = link.offsetLeft;
  const end = start + link.offsetWidth;
  if (start >= visibleStart && end <= visibleEnd) return;
  // scrollIntoView can also scroll the page, so set scrollLeft on the row.
  row.scrollLeft = start - (row.clientWidth - link.offsetWidth) / 2;
}

/** Fade each edge of the row that hides more links. */
function edgeFade(edges: HiddenEdges): CSSProperties | undefined {
  if (!edges.start && !edges.end) return undefined;
  const fade = `${EDGE_FADE_PX}px`;
  const start = edges.start ? `transparent, black ${fade}` : "black";
  const end = edges.end ? `black calc(100% - ${fade}), transparent` : "black";
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
      const { end, start } = hiddenEdges(row);
      setEdges((previous) =>
        previous.start === start && previous.end === end
          ? previous
          : { end, start },
      );
    };
    // When the row or a link changes size, place the row from its start so
    // the result depends only on the current layout, not on earlier ones.
    // A row hidden at this breakpoint has no width until it is shown.
    const observer = new ResizeObserver(() => {
      row.scrollLeft = 0;
      revealCurrentLink(row);
      updateEdges();
    });
    updateEdges();
    row.addEventListener("scroll", updateEdges, { passive: true });
    observer.observe(row);
    // Links change width when web fonts load, without resizing the row.
    for (const link of row.children) observer.observe(link);
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
