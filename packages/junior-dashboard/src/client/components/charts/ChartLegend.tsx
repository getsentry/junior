import type { ReactNode } from "react";

import { cn } from "../../styles";

type ChartLegendItem = {
  color: string;
  key: string;
  label: ReactNode;
  value?: ReactNode;
};

/** Render chart series labels with shared spacing, markers, and values. */
export function ChartLegend(props: {
  ariaLabel: string;
  inline?: boolean;
  items: readonly ChartLegendItem[];
}) {
  return (
    <ul
      aria-label={props.ariaLabel}
      className={cn(
        "m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 font-mono text-2xs text-dashboard-text-muted",
        !props.inline && "mt-4",
      )}
    >
      {props.items.map((item) => (
        <li className="flex items-center whitespace-nowrap" key={item.key}>
          <i
            aria-hidden="true"
            className="mr-1.5 block size-2 shrink-0 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          <span>
            {item.label}
            {item.value !== undefined ? (
              <>
                {" "}
                <span aria-hidden="true">·</span> {item.value}
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
