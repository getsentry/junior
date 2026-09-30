import type { AutomationSummary } from "@sentry/junior/api/schema";
import {
  ArrowRight,
  CalendarClock,
  LockKeyhole,
  MoreHorizontal,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ActorAvatar } from "../../components/ActorAvatar";
import { SelectableRow } from "../../components/SelectableRow";
import { StatusChip } from "../../components/StatusChip";
import { StatusDot } from "../../components/StatusDot";
import { formatRelativeTime, peoplePath } from "../../format";
import { cn } from "../../styles";
import {
  automationEventConditions,
  automationEventNames,
  automationScheduleLabel,
  formatAutomationRunTime,
} from "./automationFormat";

/**
 * How an automation is doing, shown by the kind tile: live work is accented,
 * work that needs a person is amber, and work that will not run again is dim.
 */
type AutomationHealth = "live" | "attention" | "dormant";

const healthTile: Record<AutomationHealth, string> = {
  live: "border-dashboard-border bg-dashboard-fill-soft text-cyan-100",
  attention: "border-amber-300/25 bg-amber-300/[0.07] text-amber-300",
  dormant:
    "border-dashboard-border-subtle bg-transparent text-dashboard-text-faint",
};

/**
 * Show one automation as a card that answers, in reading order: what is it,
 * is it healthy, when does it run and where does it post, who owns it, and
 * when it runs next and last. Instructions, timezones, and event conditions
 * stay in the details drawer.
 */
export function AutomationRow(props: {
  deleting: boolean;
  onDelete(): void;
  onSelect(): void;
  selected: boolean;
  automation: AutomationSummary;
}) {
  const { automation } = props;
  const location = useLocation();
  const status = automationStatus(automation);
  const health = automationHealth(automation);
  const Icon = automation.kind === "scheduled" ? CalendarClock : Zap;
  const creator = (
    <>
      <ActorAvatar
        imageUrl={automation.createdByAvatarUrl}
        name={automation.createdBy}
        size="list"
      />
      <span className="truncate">{automation.createdBy}</span>
    </>
  );
  return (
    <article
      className={cn(
        "min-w-0 rounded-lg border transition-colors",
        props.selected
          ? "border-cyan-300/25"
          : "border-dashboard-border-subtle hover:border-dashboard-border-strong",
      )}
      role="listitem"
    >
      <SelectableRow
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-2.5 rounded-lg p-4 sm:grid-cols-[auto_minmax(0,1fr)_10.5rem_auto] sm:gap-x-6"
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <span
          className={cn(
            "row-span-2 grid size-10 place-items-center rounded-lg border transition-colors",
            healthTile[health],
          )}
        >
          <Icon
            aria-label={
              automation.kind === "scheduled"
                ? "Scheduled automation"
                : `${automation.source} event automation`
            }
            role="img"
            size={18}
            strokeWidth={1.75}
          />
        </span>
        <div className="col-start-2 row-start-1 min-w-0">
          <button
            aria-expanded={props.selected}
            aria-label={`View automation details: ${automation.title}`}
            className="block w-full min-w-0 cursor-pointer rounded border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
            onClick={props.onSelect}
            type="button"
          >
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span
                className={cn(
                  "line-clamp-2 min-w-0 break-words font-display text-base font-medium",
                  health === "dormant"
                    ? "text-dashboard-text-muted"
                    : "text-dashboard-text",
                )}
                title={automation.title}
              >
                {automation.title}
              </span>
              {status ? (
                <StatusChip
                  className="shrink-0"
                  size="compact"
                  tone={health === "attention" ? "warning" : "neutral"}
                >
                  {status}
                </StatusChip>
              ) : null}
            </span>
            <AutomationRoute automation={automation} />
          </button>
        </div>
        {/* One footer row on narrow cards; separate grid cells on wider ones. */}
        <div className="col-span-2 col-start-2 row-start-2 flex min-w-0 items-center justify-between gap-4 sm:contents">
          <div className="flex min-w-0 text-xs text-dashboard-text-muted sm:col-start-2 sm:row-start-2">
            {automation.createdByEmail ? (
              <Link
                className="inline-flex min-w-0 max-w-full items-center gap-2 rounded no-underline transition-colors hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
                title={`Created by ${automation.createdBy}`}
                to={peoplePath(automation.createdByEmail)}
              >
                {creator}
              </Link>
            ) : (
              <span
                className="inline-flex min-w-0 max-w-full items-center gap-2"
                title={`Created by ${automation.createdBy}`}
              >
                {creator}
              </span>
            )}
          </div>
          <AutomationRuns automation={automation} />
        </div>
        <div className="col-start-3 row-start-1 -mr-2 -mt-1.5 w-11 sm:col-start-4 xl:w-9">
          {automation.ownedByViewer ? (
            <AutomationActions
              editPath={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/edit${location.search}`}
              deleting={props.deleting}
              onDelete={props.onDelete}
              title={automation.title}
            />
          ) : null}
        </div>
      </SelectableRow>
    </article>
  );
}

/** Name the one state worth flagging in the list, if the automation is not simply active. */
function automationStatus(automation: AutomationSummary): string | undefined {
  if (automation.kind === "scheduled") {
    return automation.status === "active" ? undefined : automation.status;
  }
  if (automation.status === "paused") return "paused";
  return automation.triggerAvailable ? undefined : "Trigger unavailable";
}

function automationHealth(automation: AutomationSummary): AutomationHealth {
  if (
    automation.lastRunStatus === "failed" ||
    automation.lastRunStatus === "blocked" ||
    automation.status === "blocked" ||
    (automation.kind === "event" && !automation.triggerAvailable)
  ) {
    return "attention";
  }
  return automation.status === "active" ? "live" : "dormant";
}

/** Read as a sentence: this trigger sends work to this Destination. */
function AutomationRoute({ automation }: { automation: AutomationSummary }) {
  const trigger =
    automation.kind === "scheduled"
      ? automation.schedule
      : `${automation.resource} · ${automationEventNames(automation)}`;
  const conditions =
    automation.kind === "event" ? automationEventConditions(automation) : "";
  const triggerDetail =
    automation.kind === "scheduled"
      ? automationScheduleLabel(automation)
      : conditions
        ? `${trigger} · ${conditions}`
        : trigger;
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-dashboard-text-subtle">
      <span className="min-w-0 max-w-full truncate" title={triggerDetail}>
        {trigger}
      </span>
      <span
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-dashboard-text-muted"
        title={automation.destination.label}
      >
        <ArrowRight
          aria-hidden="true"
          className="shrink-0 text-dashboard-text-faint"
          size={13}
        />
        <span className="sr-only">in</span>
        {automation.destination.visibility === "private" ? (
          <LockKeyhole
            aria-label="Private destination"
            className="shrink-0"
            role="img"
            size={12}
          />
        ) : null}
        <span className="truncate">{automation.destination.label}</span>
      </span>
    </span>
  );
}

/**
 * Show when the automation runs next and how the last run went. Next run
 * appears only when one is scheduled; the title chip already explains why a
 * paused, blocked, or completed automation has none.
 */
function AutomationRuns({ automation }: { automation: AutomationSummary }) {
  const nextRunAt =
    automation.kind === "scheduled" && automation.status === "active"
      ? automation.nextRunAt
      : undefined;
  const lastRunFailed =
    automation.lastRunStatus === "failed" ||
    automation.lastRunStatus === "blocked";
  const lastRunLabel = !automation.lastRunAt
    ? "Never run"
    : lastRunFailed
      ? `Last run ${automation.lastRunStatus}`
      : "Last run completed";
  const lastRunTime = automation.lastRunAt
    ? formatRelativeTime(automation.lastRunAt)
    : "Never";
  return (
    <dl className="m-0 grid shrink-0 grid-cols-[auto_auto] items-center gap-x-2 gap-y-1.5 text-xs sm:col-start-3 sm:row-span-2 sm:row-start-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:self-center">
      {nextRunAt ? (
        <div className="contents">
          <dt className="text-dashboard-text-faint">Next</dt>
          <dd
            className="m-0 flex min-w-0 items-center gap-2 text-dashboard-text"
            title={formatAutomationRunTime(nextRunAt)}
          >
            {/* Keeps Next and Last values on the same left edge. */}
            <span aria-hidden="true" className="w-1.5 shrink-0" />
            <span className="truncate">{formatRelativeTime(nextRunAt)}</span>
          </dd>
        </div>
      ) : null}
      <div className="contents">
        <dt className="text-dashboard-text-faint">Last</dt>
        <dd
          className="m-0 flex min-w-0 items-center gap-2"
          title={
            automation.lastRunAt
              ? `${lastRunLabel} · ${formatAutomationRunTime(automation.lastRunAt)}`
              : undefined
          }
        >
          <StatusDot
            label={lastRunLabel}
            tone={
              !automation.lastRunAt
                ? "neutral"
                : lastRunFailed
                  ? "warning"
                  : "success"
            }
          />
          {lastRunFailed ? (
            <Link
              className="text-amber-300 underline decoration-amber-300/40 underline-offset-2 hover:decoration-amber-300"
              to={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/executions`}
            >
              {automation.lastRunStatus === "failed" ? "Failed" : "Blocked"}{" "}
              {lastRunTime}
            </Link>
          ) : (
            <span
              className={
                automation.lastRunAt
                  ? "text-dashboard-text"
                  : "text-dashboard-text-muted"
              }
            >
              {lastRunTime}
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function AutomationActions(props: {
  editPath: string;
  deleting: boolean;
  onDelete(): void;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    item.current?.focus();
    function closeOutside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        } else if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          setOpen(true);
          const items = Array.from(
            root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
              [],
          );
          const index = items.indexOf(document.activeElement as HTMLElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
                  items.length;
          items[next]?.focus();
        }
      }}
      ref={root}
    >
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions: ${props.title}`}
        className="grid size-11 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed disabled:opacity-50 xl:size-9"
        disabled={props.deleting}
        onClick={() => setOpen(!open)}
        ref={trigger}
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={18} />
      </button>
      {open ? (
        <div
          aria-label={`Actions: ${props.title}`}
          className="absolute right-0 top-full z-20 min-w-36 rounded-md border border-dashboard-border bg-dashboard-surface-raised p-1 shadow-lg"
          id={menuId}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <Link
            role="menuitem"
            to={props.editPath}
            className="flex min-h-11 items-center rounded px-3 text-sm text-dashboard-text no-underline hover:bg-dashboard-fill-hover focus-visible:outline focus-visible:outline-dashboard-focus"
          >
            Edit automation
          </Link>
          <button
            className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-3 text-sm text-rose-300 hover:bg-dashboard-fill-hover focus-visible:bg-dashboard-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
            onClick={() => {
              close();
              props.onDelete();
            }}
            ref={item}
            role="menuitem"
            type="button"
          >
            <Trash2 aria-hidden="true" size={15} /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
