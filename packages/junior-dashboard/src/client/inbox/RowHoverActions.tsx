import { ArrowUpRight, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { RowDismissButton } from "./RowDismissButton";
import { RowDoneButton, RowSnoozeButton } from "./RowSnoozeDismiss";
import type { EventSnooze } from "./snoozeChoices";
import { onLinkOpen } from "./rowClick";

/** What one card does by itself: its Dismiss, Snooze, and a To-do's Done. */
export type InboxCardActions = {
  eventSnooze?: EventSnooze | undefined;
  onDismiss?(): void;
  /** Marks a To-do for the viewer done. */
  onDone?(): void;
  onSnooze?(untilMs: number): void;
  onSnoozeMenu(open: boolean): void;
  snoozeMenuOpen: boolean;
};

/** The box of one icon action on a row. */
export const ROW_ACTION_BUTTON_CLASS =
  "grid size-7 cursor-pointer place-items-center rounded-md bg-dashboard-surface-raised text-dashboard-text-muted transition hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus disabled:cursor-not-allowed";

/** An icon action on a row, such as Pin, with its name as a tooltip. */
export function RowActionButton(props: {
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick(): void;
  pressed?: boolean;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={props.label}
            aria-pressed={props.pressed}
            className={ROW_ACTION_BUTTON_CLASS}
            disabled={props.disabled}
            onClick={props.onClick}
            type="button"
          >
            {props.icon}
          </button>
        }
      />
      <TooltipContent size="compact">{props.tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The quick actions of a row with one ask: Dismiss, Snooze, and its main
 * step at the right end, as on the open card. A To-do's main step is Done.
 * A row with no main step, such as a question, gets Expand. While the row
 * is open, its card's action line holds them, so these go.
 */
export function RowQuickActions(props: {
  actions: InboxCardActions;
  expanded: boolean;
  /** The row's main step, such as opening the code change on its site. */
  main?: ReactNode;
  onExpand(): void;
}) {
  const { actions } = props;
  if (props.expanded) return null;
  return (
    <>
      {actions.onDismiss ? (
        <RowDismissButton look="icon" onClick={actions.onDismiss} />
      ) : null}
      {actions.onSnooze ? (
        <RowSnoozeButton
          eventSnooze={actions.eventSnooze}
          look="icon"
          onOpenChange={actions.onSnoozeMenu}
          onSnooze={actions.onSnooze}
          open={actions.snoozeMenuOpen}
        />
      ) : null}
      {props.main ??
        (actions.onDone ? (
          <RowDoneButton look="icon" onClick={actions.onDone} />
        ) : (
          <RowActionButton
            disabled={false}
            icon={<ChevronDown aria-hidden="true" size={14} />}
            label="Expand"
            onClick={props.onExpand}
            tooltip="Expand"
          />
        ))}
    </>
  );
}

/**
 * The hover action that opens the row's Conversation, or another owner such
 * as an Automation, in the main area.
 */
export function RowOpenLink(props: {
  label: string;
  /** Runs when the link opens. */
  onClick?(): void;
  path: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // The row names the Conversation; a search for its title finds
          // the row's head only.
          <Link
            aria-label={props.label}
            className={ROW_ACTION_BUTTON_CLASS}
            {...onLinkOpen(props.onClick)}
            to={props.path}
          >
            <ArrowUpRight aria-hidden="true" size={14} />
          </Link>
        }
      />
      <TooltipContent size="compact">{props.label}</TooltipContent>
    </Tooltip>
  );
}
