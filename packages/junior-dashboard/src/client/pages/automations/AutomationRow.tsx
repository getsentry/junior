import type { AutomationSummary } from "@sentry/junior/api/schema";
import {
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
import { formatRelativeTime, formatTime, peoplePath } from "../../format";
import { cn } from "../../styles";

const desktopColumns = "xl:grid-cols-[minmax(0,1fr)_11rem_8rem_8rem_2.75rem]";

/** Keep the management headings aligned with the row fields. */
export function AutomationListHeader() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "hidden items-center gap-4 border-b border-dashboard-border-subtle px-4 py-2.5 text-xs text-dashboard-text-muted xl:grid",
        desktopColumns,
      )}
    >
      <span>Automation</span>
      <span>Creator</span>
      <span>Next run</span>
      <span>Last run</span>
      <span className="sr-only">Actions</span>
    </div>
  );
}

/** Show the schedule with its timezone unless the schedule text already names it. */
export function automationScheduleLabel(
  automation: Extract<AutomationSummary, { kind: "scheduled" }>,
): string {
  return automation.schedule.includes(automation.timezone)
    ? automation.schedule
    : `${automation.schedule} (${automation.timezone})`;
}

/** Name event triggers in readable words. */
export function automationEventNames(
  automation: Extract<AutomationSummary, { kind: "event" }>,
): string {
  return automation.events
    .map((event) => event.replaceAll(/[._]/g, " "))
    .join(", ");
}

/** Summarize event match conditions as one readable line. */
export function automationEventConditions(
  automation: Extract<AutomationSummary, { kind: "event" }>,
): string {
  return Object.entries(automation.match ?? {})
    .map(
      ([field, value]) =>
        `${field}: ${Array.isArray(value) ? value.join(" or ") : String(value)}`,
    )
    .join(" · ");
}

/**
 * Show what an automation is, who owns it, and when it runs. Instructions,
 * timezones, and event conditions stay in the details drawer.
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
    <article role="listitem">
      <SelectableRow
        className={cn(
          "relative grid grid-cols-2 items-center gap-x-3 gap-y-2 px-4 py-3 xl:gap-x-4",
          desktopColumns,
        )}
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <button
          aria-expanded={props.selected}
          aria-label={`View automation details: ${automation.title}`}
          className="col-span-2 min-w-0 cursor-pointer rounded border-0 bg-transparent p-0 pr-11 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus xl:col-span-1 xl:pr-0"
          onClick={props.onSelect}
          type="button"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="truncate font-display text-base font-medium text-dashboard-text"
              title={automation.title}
            >
              {automation.title}
            </span>
            {status ? (
              <StatusChip
                className="shrink-0"
                size="compact"
                tone={
                  status === "completed" || status === "paused"
                    ? "neutral"
                    : "warning"
                }
              >
                {status}
              </StatusChip>
            ) : null}
          </span>
          <AutomationSummaryLine automation={automation} />
        </button>
        <div className="col-span-2 min-w-0 xl:col-span-1">
          {automation.createdByEmail ? (
            <Link
              className="inline-flex max-w-full items-center gap-2 rounded text-sm text-dashboard-text no-underline hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
              title={automation.createdBy}
              to={peoplePath(automation.createdByEmail)}
            >
              {creator}
            </Link>
          ) : (
            <span
              className="inline-flex max-w-full items-center gap-2 text-sm text-dashboard-text"
              title={automation.createdBy}
            >
              {creator}
            </span>
          )}
        </div>
        <div className="min-w-0">
          <AutomationNextRun automation={automation} />
        </div>
        <div className="min-w-0 text-right xl:text-left">
          <span className="text-xs text-dashboard-text-muted xl:hidden">
            Last run{" "}
          </span>
          <span
            className="text-xs text-dashboard-text-muted xl:text-sm xl:text-dashboard-text"
            title={
              automation.lastRunAt
                ? formatFullTime(automation.lastRunAt)
                : undefined
            }
          >
            {automation.lastRunAt
              ? formatRelativeTime(automation.lastRunAt)
              : "Never"}
          </span>
          {automation.lastRunStatus === "failed" ||
          automation.lastRunStatus === "blocked" ? (
            <Link
              className="block text-xs text-amber-300 underline"
              to={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/executions`}
            >
              Last run {automation.lastRunStatus}
            </Link>
          ) : null}
        </div>
        <div className="absolute right-3 top-3 xl:static">
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

/** Return the one state worth flagging in the list, if the automation is not simply active. */
function automationStatus(automation: AutomationSummary): string | undefined {
  if (automation.kind === "scheduled") {
    return automation.status === "active" ? undefined : automation.status;
  }
  if (automation.status === "paused") return "paused";
  return automation.triggerAvailable ? undefined : "Trigger unavailable";
}

/** Combine the trigger and Destination into one muted line under the title. */
function AutomationSummaryLine({
  automation,
}: {
  automation: AutomationSummary;
}) {
  const scheduled = automation.kind === "scheduled";
  const Icon = scheduled ? CalendarClock : Zap;
  const trigger =
    automation.kind === "scheduled"
      ? automation.schedule
      : `${automation.resource} · ${automationEventNames(automation)}`;
  const triggerDetail =
    automation.kind === "scheduled"
      ? automationScheduleLabel(automation)
      : [trigger, automationEventConditions(automation)]
          .filter(Boolean)
          .join(" · ");
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-dashboard-text-muted">
      <Icon
        aria-label={
          scheduled
            ? "Scheduled automation"
            : `${automation.source} event automation`
        }
        className="shrink-0"
        role="img"
        size={13}
      />
      <span className="min-w-0 truncate" title={triggerDetail}>
        {trigger}
      </span>
      <span aria-hidden="true" className="shrink-0 opacity-45">
        ·
      </span>
      {automation.destination.visibility === "private" ? (
        <LockKeyhole
          aria-label="Private destination"
          className="shrink-0"
          role="img"
          size={12}
        />
      ) : null}
      <span
        className="min-w-0 max-w-[45%] truncate"
        title={automation.destination.label}
      >
        {automation.destination.label}
      </span>
    </span>
  );
}

function AutomationNextRun({ automation }: { automation: AutomationSummary }) {
  if (automation.kind === "event") {
    return (
      <span className="text-xs text-dashboard-text-muted xl:text-sm">
        On event
      </span>
    );
  }
  const nextRunAt =
    automation.status === "active" ? automation.nextRunAt : undefined;
  return (
    <>
      <span className="text-xs text-dashboard-text-muted xl:hidden">
        Next run{" "}
      </span>
      <span
        className={cn(
          "text-xs text-dashboard-text-muted xl:text-sm",
          nextRunAt && "xl:text-dashboard-text",
        )}
        title={nextRunAt ? formatFullTime(nextRunAt) : undefined}
      >
        {nextRunAt ? formatRelativeTime(nextRunAt) : "—"}
      </span>
    </>
  );
}

function formatFullTime(value: string): string {
  return formatTime(value, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short",
    year: "numeric",
  });
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
