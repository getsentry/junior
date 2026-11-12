import { cn } from "../styles";

/**
 * Show how a merge count changed against an earlier period, such as
 * "+2 vs last Wed". A rise is green. A fall stays neutral, because fewer
 * merges is not an error.
 */
export function HomeMergeDelta(props: {
  current: number;
  period: string;
  previous: number;
}) {
  const delta = props.current - props.previous;
  if (delta === 0) return <>same as {props.period}</>;
  return (
    <>
      <span
        className={cn(
          "font-medium",
          delta > 0 ? "text-emerald-300" : "text-dashboard-text",
        )}
      >
        {delta > 0 ? `+${delta}` : `−${-delta}`}
      </span>{" "}
      vs {props.period}
    </>
  );
}
