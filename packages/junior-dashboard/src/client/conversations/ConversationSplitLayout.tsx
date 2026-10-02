import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const MIN_WIDTH = 256;
const DEFAULT_WIDTH = 320;
const MAX_WIDTH = 640;
const MIN_CONTENT_WIDTH = 448;

/** Keep the conversation list resizable without squeezing the main pane away. */
export function ConversationSplitLayout(props: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; width: number } | null>(null);
  const sidebarId = useId();
  const [preferredWidth, setPreferredWidth] = useState(DEFAULT_WIDTH);
  const [containerWidth, setContainerWidth] = useState(0);
  const maxWidth = containerWidth
    ? Math.max(
        MIN_WIDTH,
        Math.min(MAX_WIDTH, containerWidth - MIN_CONTENT_WIDTH),
      )
    : MAX_WIDTH;
  const width = Math.min(preferredWidth, maxWidth);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  function resize(next: number) {
    setPreferredWidth(
      Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth, next))),
    );
  }

  return (
    <div
      className="relative grid h-full min-h-0 w-full overflow-hidden bg-dashboard-bg md:grid-cols-[var(--conversation-list-width)_minmax(0,1fr)]"
      ref={containerRef}
      style={{ "--conversation-list-width": `${width}px` } as CSSProperties}
    >
      <section
        aria-label="Conversations"
        className="hidden h-full min-h-0 min-w-0 overflow-hidden md:block"
        id={sidebarId}
      >
        {props.sidebar}
      </section>
      <div
        aria-controls={sidebarId}
        aria-label="Resize conversations list"
        aria-orientation="vertical"
        aria-valuemax={maxWidth}
        aria-valuemin={MIN_WIDTH}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        className="absolute inset-y-0 left-[var(--conversation-list-width)] z-20 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none select-none items-center justify-center hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus md:flex"
        onDoubleClick={() => resize(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          let next: number;
          switch (event.key) {
            case "ArrowLeft":
              next = width - 16;
              break;
            case "ArrowRight":
              next = width + 16;
              break;
            case "Home":
              next = MIN_WIDTH;
              break;
            case "End":
              next = maxWidth;
              break;
            default:
              return;
          }
          event.preventDefault();
          resize(next);
        }}
        onLostPointerCapture={() => {
          dragRef.current = null;
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, width };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId))
            return;
          resize(drag.width + event.clientX - drag.x);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        role="separator"
        tabIndex={0}
        title="Drag or use arrow keys to resize. Double-click to reset."
      >
        <span
          aria-hidden="true"
          className="h-8 w-0.5 rounded-full bg-dashboard-border-emphasis"
        />
      </div>
      {props.children}
    </div>
  );
}
