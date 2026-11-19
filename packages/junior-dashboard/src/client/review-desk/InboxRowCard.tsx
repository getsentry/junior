import { CornerDownRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type {
  ReviewItemActionBody,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

import { conversationPath } from "../conversations/conversationRoutes";
import { ClampedDisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { FoldedNotice } from "./FoldedNotice";
import { Pill } from "./inboxAsks";
import { inboxItemKind } from "./inboxModel";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemObjects } from "./ReviewItemObjects";
import { ReviewItemSubjectPreview } from "./ReviewItemSubjectPreview";
import { ReviewItemTurnMessage } from "./ReviewItemTurnMessage";
import type { InboxCardActions } from "./RowHoverActions";
import { RowDismissButton, RowSnoozeButton } from "./RowSnoozeDismiss";
import { itemNeedsViewer, reviewItemText } from "./reviewItemFormat";

/**
 * The card of one ask in an open row: its message, form, subject, and
 * notices, with its own Snooze and Dismiss.
 */
export function InboxRowCard(props: {
  actions?: InboxCardActions;
  conversationId: string;
  /** The row's head shows the item's title. */
  headTitled: boolean;
  item: ReviewItemPayload;
  /** Notices about the item's subject (`foldNotices`). */
  notices: readonly ReviewItemPayload[];
  onAction?(item: ReviewItemPayload, body: ReviewItemActionBody): Promise<void>;
  /** The row's own actions, such as Open, on the card's action line. */
  rowActions?: ReactNode;
  take?: string;
}) {
  const { actions, item, onAction } = props;
  const showBody = item.kind === "notice" || !item.request;
  const kind = inboxItemKind(item);
  // The card's own Snooze and Dismiss: they act on this item only.
  const cardActions =
    actions || props.rowActions ? (
      <>
        {props.rowActions}
        {actions?.onSnooze ? (
          <RowSnoozeButton
            onOpenChange={actions.onSnoozeMenu}
            onSnooze={actions.onSnooze}
            open={actions.snoozeMenuOpen}
          />
        ) : null}
        {actions?.onDismiss ? (
          <RowDismissButton onClick={actions.onDismiss} />
        ) : null}
      </>
    ) : undefined;
  return (
    <section
      aria-label={item.title}
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
              {item.title}
            </h4>
          </div>
          {item.addedByLabel ? (
            <Link
              className="flex min-w-0 items-center gap-1 justify-self-start rounded-sm text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashboard-focus"
              to={conversationPath(item.addedByConversationId)}
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
      {/* What Junior said comes first, then its question and the form. */}
      {item.request ? <ReviewItemTurnMessage item={item} /> : null}
      <ReviewItemObjects conversationId={item.addedByConversationId}>
        {showBody ? (
          <ClampedDisplayText
            className="max-w-[80ch] leading-6"
            label={item.title}
            lines={4}
            text={reviewItemText(item)}
          />
        ) : null}
        {item.subject ? (
          <ReviewItemSubjectPreview
            // The Conversation that added the item keeps its subject card.
            conversationId={item.addedByConversationId}
            subject={item.subject}
            // An item row's head, or the card above it, names the subject.
            titled={!props.headTitled || !item.subject.title}
          />
        ) : null}
      </ReviewItemObjects>
      {props.notices.map((notice) => (
        <FoldedNotice
          key={notice.id}
          notice={notice}
          onAction={onAction ? (body) => onAction(notice, body) : undefined}
        />
      ))}
      {/* In the Inbox, the card's own Snooze and Dismiss replace the plain
          Dismiss, so they leave with motion. A card on its own, as in a
          Conversation, keeps the plain one. */}
      <ReviewItemActions
        dismiss={!cardActions}
        extra={cardActions}
        item={item}
        onAction={onAction ? (body) => onAction(item, body) : undefined}
        take={props.take ?? false}
      />
    </section>
  );
}
