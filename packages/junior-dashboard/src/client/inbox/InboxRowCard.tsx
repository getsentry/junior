import { CornerDownRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  InboxItemActionBody,
  InboxItemPayload,
} from "@sentry/junior/api/schema";

import { ClampedDisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { FoldedNotice } from "./FoldedNotice";
import { AutomationAlertDetails } from "./InboxAutomationRow";
import { Pill } from "./inboxAsks";
import { inboxItemKind, textRepeatsHead } from "./inboxModel";
import { InboxItemActions } from "./InboxItemActions";
import { InboxItemObjects } from "./InboxItemObjects";
import {
  InboxItemSubjectPreview,
  SubjectMergeConflict,
} from "./InboxItemSubjectPreview";
import { InboxItemTurnMessage } from "./InboxItemTurnMessage";
import type { InboxCardActions } from "./RowHoverActions";
import { RowDismissButton, RowSnoozeButton } from "./RowSnoozeDismiss";
import { InboxItemTitle } from "./InboxItemPeople";
import {
  itemConversationId,
  itemNeedsViewer,
  itemOwnerPath,
  inboxItemText,
  inboxItemTitleText,
} from "./inboxItemFormat";

/**
 * The card of one ask in an open row: its question, the message of the
 * Turn that asked it, its form, subject, and notices, with its own Snooze
 * and Dismiss.
 */
export function InboxRowCard(props: {
  actions?: InboxCardActions;
  /** The row's head shows the item's title. */
  headTitled: boolean;
  item: InboxItemPayload;
  /** Notices about the item's subject (`foldNotices`). */
  notices: readonly InboxItemPayload[];
  onAction?(item: InboxItemPayload, body: InboxItemActionBody): Promise<void>;
  /** The card's main action, first on its action line. */
  primaryAction?: ReactNode;
  /** The row's own actions, such as Open, on the card's action line. */
  rowActions?: ReactNode;
  /** The row's head shows the subject's size. */
  sizeShown?: boolean;
  take?: string;
}) {
  const { actions, item, onAction } = props;
  const text = inboxItemText(item);
  // Text that only says the head's state and number shows in Slack, not
  // here.
  const showBody =
    (item.kind === "notice" || !item.request) &&
    !(props.headTitled && textRepeatsHead(item, text));
  const kind = inboxItemKind(item);
  // Next to a main action, the others show only their icons on a phone, so
  // the line fits.
  const look = props.primaryAction ? "narrow" : undefined;
  const notices = props.notices.map((notice) => (
    <FoldedNotice
      key={notice.id}
      notice={notice}
      onAction={onAction ? (body) => onAction(notice, body) : undefined}
    />
  ));
  // The card's own Snooze and Dismiss: they act on this item only.
  const cardActions =
    actions || props.rowActions ? (
      <>
        {props.primaryAction}
        {props.rowActions}
        {actions?.onSnooze ? (
          <RowSnoozeButton
            eventSnooze={actions.eventSnooze}
            look={look}
            onOpenChange={actions.onSnoozeMenu}
            onSnooze={actions.onSnooze}
            open={actions.snoozeMenuOpen}
          />
        ) : null}
        {actions?.onDismiss ? (
          <RowDismissButton look={look} onClick={actions.onDismiss} />
        ) : null}
      </>
    ) : undefined;
  return (
    <section
      aria-label={inboxItemTitleText(item)}
      className={cn(
        "grid min-w-0 font-sans text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus",
        // An item row's head names the item, so its one card is the row's
        // detail, with no box of its own. A Conversation row boxes each ask.
        props.headTitled
          ? "gap-3 rounded-md"
          : "gap-2 rounded-lg border border-dashboard-border bg-dashboard-surface-panel p-3",
      )}
      data-inbox-card={item.id}
      data-inbox-item
      // Next moves focus here when the card before it leaves.
      tabIndex={-1}
    >
      {/* An item row's head already names the ask, its kind, and the
          sub-thread that added it. A Conversation row's head names the
          Conversation, so each ask keeps them. */}
      {props.headTitled ? null : (
        <>
          <div className="flex min-w-0 items-baseline gap-2">
            <Pill
              pill={{
                count: 1,
                key: kind,
                kind,
                name: kind,
                label: kind,
                strong: itemNeedsViewer(item),
              }}
            />
            <h4
              className={cn(
                fadeOverflowClass,
                "m-0 text-sm font-semibold text-dashboard-text",
              )}
              ref={fadeWhenOverflowing}
            >
              <InboxItemTitle item={item} links />
            </h4>
          </div>
          {item.addedByLabel ? (
            <Link
              className="flex min-w-0 items-center gap-1 justify-self-start rounded-sm text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
              to={itemOwnerPath(item)}
            >
              <CornerDownRight
                aria-hidden="true"
                className="shrink-0"
                size={12}
              />
              {/* The link is only as wide as its text, so it fades only
                  when the text does not fit. */}
              <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
                {item.addedByLabel}
              </span>
            </Link>
          ) : null}
        </>
      )}
      <InboxItemObjects conversationId={itemConversationId(item)}>
        {showBody ? (
          <ClampedDisplayText
            className="max-w-[80ch] leading-6"
            label={inboxItemTitleText(item)}
            lines={4}
            mentions={item.mentions}
            text={text}
          />
        ) : null}
        {/* A question's row head and Related already link its subject. */}
        {item.subject && !item.request ? (
          <InboxItemSubjectPreview
            // The Conversation that added the item keeps its subject card.
            conversationId={itemConversationId(item)}
            subject={item.subject}
            // An item row's head, or the card above it, names the subject.
            titled={!props.headTitled || !item.subject.title}
            sizeShown={props.sizeShown}
          />
        ) : null}
      </InboxItemObjects>
      {item.owner.kind === "automation" ? (
        <AutomationAlertDetails automationId={item.owner.id} />
      ) : null}
      {item.subject ? <SubjectMergeConflict subject={item.subject} /> : null}
      {item.request ? null : notices}
      {/* In the Inbox, the card's own Snooze and Dismiss replace the plain
          Dismiss, so they leave with motion. A card on its own, as in a
          Conversation, keeps the plain one. */}
      <InboxItemActions
        context={<InboxItemTurnMessage item={item} />}
        dismiss={!cardActions}
        extra={cardActions}
        item={item}
        onAction={onAction ? (body) => onAction(item, body) : undefined}
        take={props.take ?? false}
      />
      {/* A question comes right under the row's head, so its notices
          follow its form. */}
      {item.request ? notices : null}
    </section>
  );
}
