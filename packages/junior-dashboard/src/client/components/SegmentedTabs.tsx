import { useId, type ReactNode } from "react";

import { cn } from "../styles";

/** Switch between related panels with equal-width tabs and keyboard navigation. */
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
        className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-1"
        role="tablist"
      >
        {props.items.map((item, index) => (
          <button
            aria-controls={`${id}-panel`}
            aria-selected={props.value === item.value}
            className={cn(
              "min-h-9 min-w-0 cursor-pointer rounded-md border-0 px-3 py-2 font-sans text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus",
              props.value === item.value
                ? "bg-dashboard-fill-strong text-dashboard-text"
                : "bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-faint hover:text-dashboard-text",
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
