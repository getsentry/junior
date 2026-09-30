import type { AutomationSummary } from "@sentry/junior/api/schema";
import {
  CalendarClock,
  LockKeyhole,
  MoreHorizontal,
  Trash2,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { ActorAvatar } from "../../components/ActorAvatar";
import { SelectableRow } from "../../components/SelectableRow";
import { StatusChip } from "../../components/StatusChip";
import { formatRelativeTime, formatTime, peoplePath } from "../../format";

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
 * Show one automation as a compact card: what it is, where it posts, who owns
 * it, and when it runs. Instructions, timezones, and event conditions stay in
 * the details drawer.
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
    <article
      className="min-w-0 rounded-lg border border-dashboard-border-subtle bg-dashboard-fill-faint"
      role="listitem"
    >
      <SelectableRow
        className="flex items-start gap-3 rounded-lg px-4 py-3.5"
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <div className="min-w-0 flex-1">
          <button
            aria-expanded={props.selected}
            aria-label={`View automation details: ${automation.title}`}
            className="block w-full min-w-0 cursor-pointer rounded border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
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
          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dashboard-text-muted">
            {automation.createdByEmail ? (
              <Link
                className="inline-flex min-w-0 max-w-full items-center gap-2 rounded text-dashboard-text no-underline hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus"
                title={automation.createdBy}
                to={peoplePath(automation.createdByEmail)}
              >
                {creator}
              </Link>
            ) : (
              <span
                className="inline-flex min-w-0 max-w-full items-center gap-2 text-dashboard-text"
                title={automation.createdBy}
              >
                {creator}
              </span>
            )}
            <AutomationTiming automation={automation} />
          </div>
        </div>
        {automation.ownedByViewer ? (
          <div className="-mr-2 -mt-1.5 shrink-0">
            <AutomationActions
              editPath={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/edit${location.search}`}
              deleting={props.deleting}
              onDelete={props.onDelete}
              title={automation.title}
            />
          </div>
        ) : null}
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

/** Show next and last run as short relative times after the creator. */
function AutomationTiming({ automation }: { automation: AutomationSummary }) {
  const nextRunAt =
    automation.kind === "scheduled" && automation.status === "active"
      ? automation.nextRunAt
      : undefined;
  const lastRunTitle = automation.lastRunAt
    ? formatFullTime(automation.lastRunAt)
    : undefined;
  const lastRunFailed =
    automation.lastRunStatus === "failed" ||
    automation.lastRunStatus === "blocked";
  return (
    <>
      {nextRunAt ? (
        <MetaItem title={formatFullTime(nextRunAt)}>
          Next run {formatRelativeTime(nextRunAt)}
        </MetaItem>
      ) : null}
      <MetaItem title={lastRunTitle}>
        {lastRunFailed ? (
          <Link
            className="text-amber-300 underline"
            to={`/automations/${automation.kind}/${encodeURIComponent(automation.id)}/executions`}
          >
            Last run {automation.lastRunStatus}
            {automation.lastRunAt
              ? ` ${formatRelativeTime(automation.lastRunAt)}`
              : null}
          </Link>
        ) : automation.lastRunAt ? (
          `Last run ${formatRelativeTime(automation.lastRunAt)}`
        ) : (
          "Never run"
        )}
      </MetaItem>
    </>
  );
}

/** Keep each separator with the item after it so wrapped lines never end in a dot. */
function MetaItem(props: { children: ReactNode; title?: string }) {
  return (
    <span className="whitespace-nowrap" title={props.title}>
      <span aria-hidden="true" className="mr-2 opacity-45">
        ·
      </span>
      {props.children}
    </span>
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
