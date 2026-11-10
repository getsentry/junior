import { ArrowRight, Check, Clock3, Pin, PinOff, Zap } from "lucide-react";
import { displayPlainText } from "../display-text/plainText";

import { BriefOutcomeChip } from "../conversations/ConversationBrief";
import type { ConversationBriefReport } from "../conversations/conversationGlance";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { ClampedPreview } from "../components/ClampedPreview";
import { Button } from "../components/ui/button";
import { conversationPath } from "../conversations/conversationRoutes";
import { DisplayText } from "../display-text/DisplayText";
import { formatRelativeTime } from "../format";
import { cn } from "../styles";
import { snoozeChoices, type SnoozeChoice } from "./inboxSnooze";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemContext } from "./ReviewItemContext";
import { ReviewItemSubjectPreview } from "./ReviewItemSubjectPreview";
import { inboxBundleReason, type InboxBundle } from "./reviewItemFormat";

function Key(props: { children: ReactNode }) {
  return (
    <kbd className="ml-1.5 rounded border border-dashboard-border px-1 font-sans text-xs text-dashboard-text-faint max-md:hidden">
      {props.children}
    </kbd>
  );
}

function BundleItem(props: {
  conversationId: string;
  item: ReviewItemPayload;
  titled: boolean;
}) {
  const { item } = props;
  // A question shows in its form. Other items show their text.
  const showBody = item.kind === "notice" || !item.request;
  return (
    <section
      aria-label={item.title}
      data-inbox-item
      className="grid min-w-0 gap-3 rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel p-4 font-sans text-sm"
    >
      {props.titled ? (
        <h4 className="m-0 text-sm font-semibold text-dashboard-text">
          {item.title}
        </h4>
      ) : null}
      {showBody ? <DisplayText text={item.body} /> : null}
      {item.subject ? (
        <ReviewItemSubjectPreview
          conversationId={props.conversationId}
          subject={item.subject}
        />
      ) : null}
      <ReviewItemActions item={item} />
    </section>
  );
}

/**
 * One inbox bundle: the Review items of one Conversation. Collapsed, it
 * shows the Conversation, the newest ask, and why it is here. Expanded in
 * place, it shows the end of the Conversation and each item with its
 * answer controls, then the bundle actions.
 */
export function InboxBundleView(props: {
  active: boolean;
  bundle: InboxBundle;
  donePending: boolean;
  expanded: boolean;
  onActivate(): void;
  onDone(): void;
  onSnooze(choice: SnoozeChoice): void;
  onSnoozeMenu(open: boolean): void;
  onToggle(): void;
  onPin(): void;
  pinned: boolean;
  snoozeMenuOpen: boolean;
  /** The Conversation title, when it is known. */
  title?: string;
  /**
   * A row for one item: the item title leads, and the Conversation title
   * follows unless the bundle is that Conversation.
   */
  itemRow?: { showConversation: boolean };
  /** The Conversation's Brief, when it has one. */
  brief?: ConversationBriefReport;
}) {
  const { bundle } = props;
  const { newest } = bundle;
  const conversationTitle =
    props.title ?? (newest.automationId ? "Automation" : newest.title);
  const title = props.itemRow ? newest.title : conversationTitle;
  // A bundle row shows its Conversation's Brief; a single-item row does not.
  const brief = props.itemRow ? undefined : props.brief;
  const subline = props.itemRow
    ? props.itemRow.showConversation
      ? conversationTitle
      : undefined
    : newest.title;
  const count = bundle.items.length;
  const reason = inboxBundleReason(bundle);
  const canDone = bundle.items.some(
    (item) => item.status === "open" && item.canAct,
  );
  const regionId = `inbox-bundle-${bundle.key}`;
  return (
    <li
      className={cn(
        // Each bundle is a card. An open one lifts out of the stream, as in
        // Google Inbox: more room above and below, and a deeper shadow.
        "min-w-0 list-none rounded-xl border transition-[margin,box-shadow,background-color] duration-200",
        props.expanded
          ? "my-4 border-dashboard-border-emphasis bg-dashboard-surface-raised shadow-[0_18px_44px_-14px_rgb(0_0_0/0.75),0_4px_14px_-6px_rgb(0_0_0/0.5)] light:shadow-[0_18px_44px_-14px_rgb(15_15_30/0.28),0_4px_14px_-6px_rgb(15_15_30/0.16)] md:-mx-2"
          : "border-dashboard-border bg-dashboard-surface-panel shadow-[0_1px_2px_rgb(0_0_0/0.4)] light:shadow-[0_1px_3px_rgb(15_15_30/0.08)]",
      )}
      onFocus={props.onActivate}
    >
      <button
        aria-controls={regionId}
        aria-expanded={props.expanded}
        className={cn(
          "grid w-full min-w-0 cursor-pointer grid-cols-[0.875rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl border-0 bg-transparent px-4 py-3 text-left font-sans comfortable:py-4 text-inherit transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
          props.active && !props.expanded && "bg-dashboard-fill-soft",
        )}
        data-inbox-bundle={bundle.key}
        onClick={props.onToggle}
        tabIndex={props.active ? 0 : -1}
        type="button"
      >
        <span
          aria-hidden="true"
          className={cn(
            "mt-[0.4rem] size-2 justify-self-center rounded-full",
            bundle.needsYou
              ? "bg-dashboard-accent"
              : "border border-dashboard-text-faint",
          )}
        />
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 truncate text-sm leading-snug",
                bundle.needsYou
                  ? "font-semibold text-dashboard-text"
                  : "font-medium text-dashboard-text-muted",
              )}
            >
              {title}
            </span>
            {brief ? (
              <BriefOutcomeChip
                className="shrink-0"
                status={brief.content.outcome.status}
              />
            ) : null}
          </span>
          {/* The Brief says what the work is about, under its title. */}
          {brief ? (
            <span className="truncate text-xs leading-snug text-dashboard-text-muted">
              {displayPlainText(brief.content.summary, brief.mentions)}
            </span>
          ) : null}
          {subline || reason ? (
            <span className="flex min-w-0 items-baseline gap-1.5 text-xs leading-tight">
              {subline ? (
                <span className="min-w-0 truncate text-dashboard-text">
                  {subline}
                </span>
              ) : null}
              {reason ? (
                <span className="shrink-0 text-dashboard-text-muted">
                  {subline ? "· " : ""}
                  {reason}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 pt-0.5 text-xs tabular-nums text-dashboard-text-faint">
          {props.pinned ? (
            <Pin
              aria-label="Pinned"
              className="size-3.5 text-dashboard-accent-text"
              role="img"
            />
          ) : null}
          {/* The newest item's time, which also picks the time section. */}
          {formatRelativeTime(bundle.waitingSince)}
        </span>
      </button>
      {props.expanded ? (
        <div
          className="grid min-w-0 gap-4 px-4 pb-4 md:px-6"
          data-inbox-answer={bundle.key}
          id={regionId}
          role="region"
          aria-label={`${title}: review items`}
        >
          {/* Bundle actions sit by its title, so keys show what they do. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-dashboard-border pb-3">
            {canDone ? (
              <Button
                disabled={props.donePending}
                onClick={props.onDone}
                variant="quiet"
              >
                <Check aria-hidden="true" size={15} />
                Done
                <Key>e</Key>
              </Button>
            ) : null}
            <Button
              aria-pressed={props.pinned}
              onClick={props.onPin}
              variant="quiet"
            >
              {props.pinned ? (
                <PinOff aria-hidden="true" size={15} />
              ) : (
                <Pin aria-hidden="true" size={15} />
              )}
              {props.pinned ? "Unpin" : "Pin"}
              <Key>p</Key>
            </Button>
            <Button
              aria-expanded={props.snoozeMenuOpen}
              onClick={() => props.onSnoozeMenu(!props.snoozeMenuOpen)}
              variant="quiet"
            >
              <Clock3 aria-hidden="true" size={15} />
              Snooze
              <Key>h</Key>
            </Button>
            {props.snoozeMenuOpen ? (
              <div
                aria-label="Snooze until"
                className="flex flex-wrap items-center gap-1"
                role="group"
              >
                {snoozeChoices.map((choice, index) => (
                  <Button
                    key={choice.label}
                    onClick={() => props.onSnooze(choice)}
                  >
                    {choice.label}
                    <Key>{index + 1}</Key>
                  </Button>
                ))}
              </div>
            ) : null}
            {props.snoozeMenuOpen ? (
              <SnoozeUntilEvent
                bundle={bundle}
                onPick={() => props.onSnoozeMenu(false)}
              />
            ) : null}
            <Link
              className="ml-auto inline-flex items-center gap-1.5 font-sans text-sm font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
              to={conversationPath(bundle.conversationId, {
                turnId: newest.addedByTurnId,
              })}
            >
              Open conversation
              <ArrowRight aria-hidden="true" size={14} />
              <Key>o</Key>
            </Link>
          </div>
          <ClampedPreview
            className="leading-6"
            label="Conversation context"
            lines={10}
          >
            <ReviewItemContext
              fallback={null}
              // The newest ask is where the Conversation is now.
              item={newest}
            />
          </ClampedPreview>
          {bundle.items.map((item) => (
            <BundleItem
              conversationId={bundle.conversationId}
              item={item}
              key={item.id}
              titled={count > 1 || !item.request}
            />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Prototype only: snooze until something happens, not a time. The choices
 * show the idea and do nothing yet beyond closing the menu.
 */
function SnoozeUntilEvent(props: { bundle: InboxBundle; onPick(): void }) {
  const pr = props.bundle.items
    .map((item) => item.subject?.url?.match(/\/pull\/(\d+)/)?.[1])
    .find(Boolean);
  const choices = [
    pr ? `When PR #${pr} merges` : "When PR #91 merges",
    "When automation Weekly project summary runs",
    "When this PR opens",
  ];
  return (
    <div
      aria-label="Snooze until something happens"
      className="flex basis-full flex-wrap items-center gap-1 pl-0.5"
      role="group"
    >
      <span className="pr-1 font-sans text-xs text-dashboard-text-faint">
        Or until
      </span>
      {choices.map((label) => (
        <Button
          className="border-dashed"
          key={label}
          onClick={props.onPick}
          title="Prototype: not wired up yet"
          variant="quiet"
        >
          <Zap aria-hidden="true" size={14} />
          {label}
        </Button>
      ))}
    </div>
  );
}
