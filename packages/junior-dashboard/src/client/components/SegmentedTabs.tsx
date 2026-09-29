import { useId, type ReactNode } from "react";

import { cn } from "../styles";

/** Style the outer frame shared by segmented tabs and segmented page links. */
export const segmentedTabsFrameClass =
  "rounded-lg border border-dashboard-border bg-dashboard-surface-panel";

/** Style the spacing inside a segmented track. */
export const segmentedTabsInsetClass = "gap-1 p-1";

/** Style the full track: frame plus inner spacing. */
export const segmentedTabsTrackClass = `${segmentedTabsFrameClass} ${segmentedTabsInsetClass}`;

/** Style one segmented tab or segmented page link. */
export function segmentedTabClass(selected: boolean): string {
  return cn(
    "min-h-9 cursor-pointer rounded-md border-0 px-3 py-2 font-sans text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
    selected
      ? "bg-dashboard-fill-strong text-dashboard-text"
      : "bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-faint hover:text-dashboard-text",
  );
}

/**
 * Switch between related panels with equal-width tabs and keyboard navigation.
 * Use `SegmentedNav` for links between pages; it shares these styles.
 */
export function SegmentedTabs<const Value extends string>(props: {
  children: ReactNode;
  label: string;
  items: readonly { label: string; value: Value }[];
  onChange(value: NoInfer<Value>): void;
  value: NoInfer<Value>;
}) {
  const id = useId();

  return (
    <div className="grid min-w-0 gap-4">
      <div
        aria-label={props.label}
        className={cn(
          "grid auto-cols-fr grid-flow-col",
          segmentedTabsTrackClass,
        )}
        role="tablist"
      >
        {props.items.map((item, index) => (
          <button
            aria-controls={`${id}-panel`}
            aria-selected={props.value === item.value}
            className={cn(
              "min-w-0",
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
            {item.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`${id}-${props.value}`}
        className="min-w-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
        id={`${id}-panel`}
        role="tabpanel"
        tabIndex={0}
      >
        {props.children}
      </div>
    </div>
  );
}
