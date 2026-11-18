import { ArrowUpRight, Check, Clock3 } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import type { SnoozeChoice } from "./inboxSnooze";
import { RowSnoozeButton } from "./RowSnoozeDismiss";

/** What one card does by itself: its Dismiss and Snooze. */
export type InboxCardActions = {
  onDismiss?(): void;
  onSnooze?(choice: SnoozeChoice): void;
  onSnoozeMenu(open: boolean): void;
  pending: boolean;
  snoozeMenuOpen: boolean;
};

const ROW_ACTION_BUTTON_CLASS =
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
 * The quick actions of a row with one ask: Open, Snooze and Dismiss. While
 * the row is open, its card holds Snooze and Dismiss.
 */
export function RowQuickActions(props: {
  actions: InboxCardActions;
  expanded: boolean;
  to: string;
}) {
  const { actions } = props;
  return (
    <>
      <RowOpenLink to={props.to} />
      {!props.expanded && actions.onSnooze ? (
        <RowSnoozeButton
          onOpenChange={actions.onSnoozeMenu}
          onSnooze={actions.onSnooze}
          open={actions.snoozeMenuOpen}
          trigger={
            <button
              aria-label="Snooze"
              className={ROW_ACTION_BUTTON_CLASS}
              title="Snooze"
              type="button"
            >
              <Clock3 aria-hidden="true" size={14} />
            </button>
          }
        />
      ) : null}
      {!props.expanded && actions.onDismiss ? (
        <RowActionButton
          disabled={actions.pending}
          icon={<Check aria-hidden="true" size={14} />}
          label="Dismiss"
          onClick={actions.onDismiss}
          tooltip="Dismiss"
        />
      ) : null}
    </>
  );
}

/** The hover action that opens the row's Conversation in the main area. */
export function RowOpenLink(props: { to: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // The row names the Conversation; a search for its title finds
          // the row's head only.
          <Link
            aria-label="Open conversation"
            className={ROW_ACTION_BUTTON_CLASS}
            to={props.to}
          >
            <ArrowUpRight aria-hidden="true" size={14} />
          </Link>
        }
      />
      <TooltipContent size="compact">Open conversation</TooltipContent>
    </Tooltip>
  );
}
