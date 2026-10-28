import { useId, type ReactNode } from "react";

import { cn } from "../styles";

/** Style the border and fill of the segmented pill track. */
const segmentedTabsFrameClass =
  "rounded-lg border border-dashboard-border bg-dashboard-surface-panel";

/** Style the spacing inside the segmented pill track. */
const segmentedTabsInsetClass = "gap-1 p-1";

/** Style one tab or link in the segmented pill track. */
export function segmentedTabClass(selected: boolean): string {
  return cn(
    "min-h-9 cursor-pointer rounded-md border-0 px-1.5 py-2 font-sans text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
    selected
      ? "bg-dashboard-fill-strong text-dashboard-text"
      : "bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-faint hover:text-dashboard-text",
  );
}

/** Switch between related panels. Tabs share the row equally on wide screens. */
export function SegmentedTabs<const Value extends string>(props: {
  children: ReactNode;
  label: string;
  /** `count` is the number of entries in the panel. Zero and unknown counts are hidden. */
  items: readonly { count?: number; label: string; value: Value }[];
  onChange(value: NoInfer<Value>): void;
  value: NoInfer<Value>;
}) {
  const id = useId();

  return (
    <div className="grid min-w-0 gap-4">
      <div
        aria-label={props.label}
        className={cn(
          "flex min-w-0",
          segmentedTabsFrameClass,
          segmentedTabsInsetClass,
        )}
        role="tablist"
      >
        {props.items.map((item, index) => (
          <button
            aria-controls={`${id}-panel`}
            aria-selected={props.value === item.value}
            className={cn(
              "inline-flex min-w-0 flex-auto items-center justify-center gap-1.5 sm:flex-1",
              segmentedTabClass(props.value === item.value),
            )}
            id={`${id}-${item.value}`}
            key={item.value}
            onClick={() => props.onChange(item.value)}
            onKeyDown={(event) => {
              let nextIndex: number;
              const count = props.items.length;
              switch (event.key) {
                case "ArrowLeft":
                  nextIndex = (index + count - 1) % count;
                  break;
                case "ArrowRight":
                  nextIndex = (index + 1) % count;
                  break;
                case "Home":
                  nextIndex = 0;
                  break;
                case "End":
                  nextIndex = count - 1;
                  break;
                default:
                  return;
              }
              event.preventDefault();
              props.onChange(props.items[nextIndex]!.value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                [nextIndex]?.focus();
            }}
            role="tab"
            tabIndex={props.value === item.value ? 0 : -1}
            type="button"
          >
            <span className="truncate">{item.label}</span>
            {item.count ? (
              <span className="min-w-5 shrink-0 rounded-full bg-dashboard-fill-strong px-1.5 text-center text-xs font-semibold leading-5 tabular-nums">
                {item.count.toLocaleString("en-US")}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${id}-${props.value}`}
        className="min-w-0 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
        id={`${id}-panel`}
        role="tabpanel"
        tabIndex={0}
      >
        {props.children}
      </div>
    </div>
  );
}
