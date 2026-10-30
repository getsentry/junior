import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Link, NavLink, useLocation } from "react-router";

import { pathWithSearch } from "../searchParams";
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
 * Show links between sibling pages as underline tabs. The current page has
 * a solid underline that sits on the border below the row. App navigation
 * uses pills and in-place panel switches use `ui/tabs`, so the three
 * levels stay distinct.
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
    // Recompute the scroll position from the start on every size change so it
    // depends only on the current layout. A row hidden at this breakpoint has
    // no width until it is shown.
    const observer = new ResizeObserver(() => {
      row.scrollLeft = 0;
      revealCurrentLink(row);
      updateEdges();
    });
    updateEdges();
    row.addEventListener("scroll", updateEdges, { passive: true });
    observer.observe(row);
    // Links can change width, for example when a web font loads, without
    // resizing the row.
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
      "relative flex h-10 items-center justify-center whitespace-nowrap font-sans text-sm font-medium no-underline transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
      isActive
        ? "text-dashboard-text after:bg-dashboard-text-solid"
        : "text-dashboard-text-muted hover:text-dashboard-text",
      props.fill ? "min-w-max flex-[1_0_0]" : "shrink-0",
    );

  return (
    <nav
      aria-label={props.ariaLabel}
      className={cn("flex min-w-0 max-w-full", !props.fill && "w-fit")}
    >
      <div
        className={cn(
          "relative -mx-1 flex gap-5 px-1 min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
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
