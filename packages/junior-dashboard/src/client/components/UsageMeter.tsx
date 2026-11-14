import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { PersonalSpendReport } from "@sentry/junior/api/schema";

import { formatCostSummary } from "../format";
import { cn } from "../styles";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Progress } from "./ui/progress";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

const SPEND_COUNT_UP_MS = 700;
const WARNING_PERCENT = 75;

type CapWindow = {
  capUsd: number;
  label: string;
  percent: number;
  spentUsd: number;
};

/** Compare both rolling windows with their soft caps. */
function capWindows(spend: PersonalSpendReport) {
  const weekly = {
    capUsd: spend.weeklySoftCapUsd,
    label: "Weekly soft cap",
    percent: (spend.sevenDaysUsd / spend.weeklySoftCapUsd) * 100,
    spentUsd: spend.sevenDaysUsd,
  };
  const monthly = {
    capUsd: spend.monthlySoftCapUsd,
    label: "Monthly soft cap",
    percent: (spend.thirtyDaysUsd / spend.monthlySoftCapUsd) * 100,
    spentUsd: spend.thirtyDaysUsd,
  };
  // The ring shows the cap that the viewer is closest to.
  const closest = monthly.percent > weekly.percent ? monthly : weekly;
  return { closest, monthly, weekly };
}

function percentLabel(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.floor(percent)}%`;
}

function wholeDollars(usd: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(usd);
}

// The sidebar row fits about six characters for each total.
function compactSpend(usd: number): string {
  if (usd < 100) return formatCostSummary({ total: usd });
  if (usd < 1000) return wholeDollars(usd);
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 1,
    notation: "compact",
    style: "currency",
  }).format(usd);
}

function levelClass(percent: number): string {
  if (percent >= 100) return "text-rose-300";
  if (percent >= WARNING_PERCENT) return "text-amber-300";
  return "text-dashboard-accent";
}

/**
 * Show one spend total. When the total changes, count up from the last shown
 * value and tint the figure until the count ends.
 */
function SpendAmount({ value }: { value?: number }) {
  const [shown, setShown] = useState(value);
  const [counting, setCounting] = useState(false);
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    if (
      value === undefined ||
      from === undefined ||
      from === value ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      shownRef.current = value;
      setShown(value);
      setCounting(false);
      return;
    }

    const startedAt = performance.now();
    let frame = 0;
    const step = (time: number) => {
      const progress = Math.min(1, (time - startedAt) / SPEND_COUNT_UP_MS);
      const eased = 1 - (1 - progress) ** 3;
      const next = progress < 1 ? from + (value - from) * eased : value;
      shownRef.current = next;
      setShown(next);
      if (progress < 1) {
        frame = requestAnimationFrame(step);
      } else {
        setCounting(false);
      }
    };
    setCounting(true);
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <span
      className={cn(
        "transition-colors duration-700 motion-reduce:transition-none",
        counting && "text-dashboard-accent-text",
      )}
    >
      {shown === undefined ? "—" : compactSpend(shown)}
    </span>
  );
}

/**
 * Draw progress toward the closest soft cap. The full track always shows and
 * the arc never rotates, so the ring does not read as a loading spinner.
 */
function UsageRing({ percent }: { percent?: number }) {
  const filled = percent === undefined ? 0 : Math.min(100, percent);
  return (
    <svg
      aria-hidden="true"
      className="size-5 shrink-0 -rotate-90"
      data-usage-ring=""
      viewBox="0 0 20 20"
    >
      <circle
        className="stroke-dashboard-border-interactive"
        cx="10"
        cy="10"
        fill="none"
        r="8"
        strokeWidth="2.5"
      />
      {filled > 0 ? (
        <circle
          className={cn(
            "stroke-current transition-[stroke-dasharray] duration-700 ease-out motion-reduce:transition-none",
            levelClass(percent!),
          )}
          cx="10"
          cy="10"
          fill="none"
          pathLength={100}
          r="8"
          strokeDasharray={`${Math.max(filled, 2)} 100`}
          strokeLinecap="round"
          strokeWidth="2.5"
        />
      ) : null}
    </svg>
  );
}

function CapRow({ window }: { window: CapWindow }) {
  return (
    <div className="grid gap-1.5 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-dashboard-text">{window.label}</span>
        <span
          className={cn(
            "font-semibold tabular-nums",
            window.percent >= WARNING_PERCENT
              ? levelClass(window.percent)
              : "text-dashboard-text",
          )}
        >
          {percentLabel(window.percent)}
        </span>
      </div>
      <Progress
        aria-label={window.label}
        className={levelClass(window.percent)}
        getAriaValueText={() => percentLabel(window.percent)}
        value={Math.min(100, window.percent)}
      />
      <span className="tabular-nums text-dashboard-text-muted">
        {formatCostSummary({ total: window.spentUsd })} of{" "}
        {wholeDollars(window.capUsd)}
      </span>
    </div>
  );
}

const POPOVER_SIDE = {
  sheet: "top",
  sidebar: "right",
  "top-bar": "bottom",
} as const;

/**
 * Keep the viewer's rolling spend in view. `sidebar` is the nav sidebar
 * footer row (ring only when the sidebar is collapsed). `top-bar` sits beside
 * the avatar in the desktop top bar. `sheet` is the row in the mobile
 * navigation sheet. Click opens both windows against their caps.
 */
export function UsageMeter(props: {
  /** Viewer's People page, which charts spend by day. */
  detailsTo: string;
  spend?: PersonalSpendReport;
  unavailable?: boolean;
  variant: "sheet" | "sidebar" | "top-bar";
}) {
  const [open, setOpen] = useState(false);
  const windows = props.spend ? capWindows(props.spend) : undefined;
  const closest = windows?.closest;
  const sevenDays = props.spend
    ? formatCostSummary({ total: props.spend.sevenDaysUsd })
    : "—";
  const thirtyDays = props.spend
    ? formatCostSummary({ total: props.spend.thirtyDaysUsd })
    : "—";
  const summary = closest
    ? `${percentLabel(closest.percent)} of ${closest.label.toLowerCase()}`
    : props.unavailable
      ? "Usage unavailable"
      : "Loading usage";
  const label = closest
    ? `Usage: ${summary}. 7 days ${sevenDays}, 30 days ${thirtyDays}.`
    : summary;

  const content = (
    <>
      <UsageRing percent={closest?.percent} />
      <span
        className="flex min-w-0 items-baseline gap-1 whitespace-nowrap text-xs tabular-nums text-dashboard-text-muted group-data-[collapsible=icon]:hidden"
        data-usage-totals=""
      >
        7d
        <span className="font-semibold text-dashboard-text">
          <SpendAmount value={props.spend?.sevenDaysUsd} />
        </span>
        <span aria-hidden="true">·</span>
        30d
        <span className="font-semibold text-dashboard-text">
          <SpendAmount value={props.spend?.thirtyDaysUsd} />
        </span>
      </span>
    </>
  );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      {props.variant === "sidebar" ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label={label}
            className={cn(
              "h-10 gap-2 rounded-lg px-2.5 group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! [&_svg]:size-5",
              open && "bg-sidebar-accent",
            )}
            render={<PopoverTrigger />}
            tooltip={{ children: summary, size: "compact", sideOffset: 6 }}
          >
            {content}
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <PopoverTrigger
          aria-label={label}
          className={cn(open && "bg-dashboard-fill-strong")}
          render={
            <Button
              size={props.variant === "sheet" ? "menu" : "default"}
              variant="ghost"
            />
          }
        >
          {content}
        </PopoverTrigger>
      )}
      <PopoverContent
        align="end"
        className="grid w-72 gap-3 rounded-xl border-0 bg-dashboard-surface-raised/95 p-3.5 shadow-2xl shadow-black/75 backdrop-blur-xl"
        id="usage-popover"
        side={POPOVER_SIDE[props.variant]}
      >
        {windows ? (
          <>
            <CapRow window={windows.weekly} />
            <CapRow window={windows.monthly} />
          </>
        ) : (
          <p className="m-0 text-xs text-dashboard-text-muted">{summary}.</p>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-dashboard-border-strong pt-2.5 text-xs">
          <span className="text-dashboard-text-muted">
            Rolling 7 and 30 days, UTC
          </span>
          <Link
            className="text-dashboard-accent-text no-underline hover:underline"
            onClick={() => setOpen(false)}
            to={props.detailsTo}
          >
            Details
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
