import { ChevronDown } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "../styles";

const FADE_LINES = 1.65;

/**
 * Show the first `lines` lines of long content with a fade and a toggle that
 * expands it. Short content shows in full with no toggle. `className` sets
 * the line height that `lines` counts.
 */
export function ClampedPreview(props: {
  children: ReactNode;
  className?: string;
  /** What the toggle expands, for its accessible name. */
  label: string;
  lines: number;
}) {
  const { lines } = props;
  const id = useId();
  const previewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsed = hasMore && !expanded;

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const content = contentRef.current;
    if (!preview || !content) return;

    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(preview).lineHeight,
      );
      const height = lineHeight * lines;
      const overflows = content.getBoundingClientRect().height > height + 0.5;
      const focused = document.activeElement;
      if (
        overflows &&
        focused &&
        content.contains(focused) &&
        focused.getBoundingClientRect().bottom >
          preview.getBoundingClientRect().top + height - lineHeight * FADE_LINES
      ) {
        setExpanded(true);
      } else if (!overflows && focused && focused === toggleRef.current) {
        preview.focus({ preventScroll: true });
      }
      setHasMore(overflows);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [lines]);

  useLayoutEffect(() => {
    const toggle = toggleRef.current;
    if (!expanded && toggle && document.activeElement === toggle) {
      toggle.scrollIntoView({ block: "nearest" });
    }
  }, [expanded]);

  return (
    <div className="relative min-w-0">
      <div
        className={cn(props.className, collapsed && "overflow-clip")}
        id={id}
        onFocusCapture={(event) => {
          if (!collapsed) return;
          // Keep focused links clear of both the clipping and the fade.
          const preview = event.currentTarget;
          const lineHeight = Number.parseFloat(
            getComputedStyle(preview).lineHeight,
          );
          if (
            event.target.getBoundingClientRect().bottom >
            preview.getBoundingClientRect().bottom - lineHeight * FADE_LINES
          ) {
            setExpanded(true);
          }
        }}
        ref={previewRef}
        style={
          collapsed
            ? {
                maskImage: `linear-gradient(black calc(100% - ${FADE_LINES}lh), transparent)`,
                maxHeight: `${lines}lh`,
              }
            : undefined
        }
        tabIndex={-1}
      >
        <div ref={contentRef}>{props.children}</div>
      </div>
      {hasMore ? (
        <button
          aria-controls={id}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${props.label}`}
          className={cn(
            "group flex h-6 w-8 cursor-pointer items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-dashboard-focus",
            collapsed
              ? "absolute bottom-0 left-1/2 -translate-x-1/2"
              : "mx-auto mt-1",
          )}
          onClick={() => setExpanded((open) => !open)}
          ref={toggleRef}
          type="button"
        >
          <span
            aria-hidden="true"
            className="grid size-5 place-items-center rounded-full border border-dashboard-border bg-dashboard-ink text-dashboard-text-solid transition-[filter] group-hover:brightness-95 dark:bg-dashboard-text-solid dark:text-dashboard-text-inverse"
          >
            <ChevronDown
              className="size-4 group-aria-expanded:rotate-180"
              strokeWidth={2.25}
            />
          </span>
        </button>
      ) : null}
    </div>
  );
}
