import type { AutomationSummary } from "@sentry/junior/api/schema";
import { CalendarClock, MoreHorizontal, Trash2, Zap } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { ActorAvatar } from "../../components/ActorAvatar";
import { SelectableRow } from "../../components/SelectableRow";
import { StatusChip } from "../../components/StatusChip";
import { formatRelativeTime, formatTime, peoplePath } from "../../format";
import { cn } from "../../styles";

const desktopColumns =
  "xl:grid-cols-[minmax(0,1fr)_9rem_16rem_10rem_7rem_2.75rem]";

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
      <span>Trigger</span>
      <span>Destination</span>
      <span>Last run</span>
      <span className="sr-only">Actions</span>
    </div>
  );
}

/** Show purpose, ownership, and trigger state without opening the details. */
export function AutomationRow(props: {
  deleting: boolean;
  onDelete(): void;
  onSelect(): void;
  selected: boolean;
  automation: AutomationSummary;
}) {
  const { automation } = props;
  const creator = (
    <>
      <ActorAvatar
        imageUrl={automation.createdByAvatarUrl}
        name={automation.createdBy}
        size="detail"
      />
      <span className="truncate">{automation.createdBy}</span>
    </>
  );
  return (
    <article role="listitem">
      <SelectableRow
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.75rem] items-center gap-x-4 gap-y-3 px-4 py-3",
          desktopColumns,
        )}
        onSelect={props.onSelect}
        selected={props.selected}
      >
        <button
          aria-expanded={props.selected}
          aria-label={`View automation details: ${automation.title}`}
          className="col-span-2 min-w-0 cursor-pointer rounded border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus xl:col-span-1"
          onClick={props.onSelect}
          type="button"
        >
          <span
            className="block truncate font-display text-base font-medium text-dashboard-text"
            title={automation.title}
          >
            {automation.title}
          </span>
          <span
            className="mt-1 block truncate text-xs text-dashboard-text-muted"
            title={automation.instruction}
          >
            {automation.instruction}
          </span>
        </button>
        <div className="col-span-2 row-start-2 min-w-0 xl:col-span-1 xl:row-auto">
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
        <div className="col-span-3 min-w-0 xl:col-span-1">
          <AutomationTrigger automation={automation} />
        </div>
        <div className="col-span-2 min-w-0 xl:col-span-1">
          <span className="text-xs text-dashboard-text-muted xl:hidden">
            Destination ·{" "}
          </span>
          <span className="break-words text-sm text-dashboard-text">
            {automation.destination.label}
          </span>
          <div className="mt-1 text-xs capitalize text-dashboard-text-muted">
            {automation.destination.visibility}
          </div>
        </div>
        <div className="col-span-3 min-w-0 xl:col-span-1">
          <span className="text-xs text-dashboard-text-muted xl:hidden">
            Last run ·{" "}
          </span>
          <span
            className="text-sm text-dashboard-text"
            title={
              automation.lastRunAt
                ? formatTime(automation.lastRunAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : undefined
            }
          >
            {automation.lastRunAt
              ? formatRelativeTime(automation.lastRunAt)
              : "Never"}
          </span>
        </div>
        <div className="col-start-3 row-start-1 xl:col-auto xl:row-auto">
          {automation.ownedByViewer ? (
            <AutomationActions
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

function AutomationTrigger({ automation }: { automation: AutomationSummary }) {
  const scheduled = automation.kind === "scheduled";
  const Icon = scheduled ? CalendarClock : Zap;
  const summary = scheduled
    ? automation.schedule.includes(automation.timezone)
      ? automation.schedule
      : `${automation.schedule} (${automation.timezone})`
    : automation.resource;
  return (
    <div className="flex items-start gap-2">
      <Icon
        aria-label={
          scheduled
            ? "Scheduled automation"
            : `${automation.source} event automation`
        }
        className="mt-0.5 shrink-0 text-dashboard-text-muted"
        role="img"
        size={16}
      />
      <div className="min-w-0">
        <div className="break-words text-sm text-dashboard-text">{summary}</div>
        <div className="mt-1 break-words text-xs text-dashboard-text-muted">
          {scheduled
            ? automation.status === "active" && automation.nextRunAt
              ? `Next ${new Date(automation.nextRunAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: automation.timezone, timeZoneName: "short" })}`
              : automation.status === "blocked"
                ? "Future runs are blocked"
                : "No next run"
            : automation.events
                .map((event) => event.replaceAll(/[._]/g, " "))
                .join(", ")}
        </div>
        {!scheduled &&
        automation.match &&
        Object.keys(automation.match).length > 0 ? (
          <div className="mt-1 break-words text-xs text-dashboard-text-muted">
            {Object.entries(automation.match)
              .map(
                ([field, value]) =>
                  `${field}: ${Array.isArray(value) ? value.join(" or ") : String(value)}`,
              )
              .join(" · ")}
          </div>
        ) : null}
        {scheduled && automation.status !== "active" ? (
          <StatusChip
            className="mt-2"
            size="compact"
            tone={automation.status === "blocked" ? "warning" : "neutral"}
          >
            {automation.status}
          </StatusChip>
        ) : !scheduled && !automation.triggerAvailable ? (
          <StatusChip className="mt-2" size="compact" tone="warning">
            Trigger unavailable
          </StatusChip>
        ) : null}
      </div>
    </div>
  );
}

function AutomationActions(props: {
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
          item.current?.focus();
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
