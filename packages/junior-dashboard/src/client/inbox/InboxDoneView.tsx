import { ArrowUpRight, Check, X } from "lucide-react";
import { Link } from "react-router";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import {
  INBOX_ROW_DETAIL_CLASS,
  inboxCardClass,
  inboxRowButtonClass,
} from "./inboxRowStyles";
import { InboxSection } from "./InboxSection";
import { doneSections } from "./inboxModel";
import { InboxItemActions } from "./InboxItemActions";
import { InboxItemObjects } from "./InboxItemObjects";
import { InboxItemSubjectPreview } from "./InboxItemSubjectPreview";
import {
  answerLine,
  itemConversationId,
  itemOwnerLinkLabel,
  itemOwnerPath,
  inboxItemText,
} from "./inboxItemFormat";
import { formatRelativeTime } from "../time";
import { fadeOverflowClass, fadeWhenOverflowing } from "../textFade";
import { InboxItemCloser, InboxItemTitle } from "./InboxItemPeople";
import { inboxItemTitleText } from "./inboxItemFormat";

/** The answer, or the reason that the item closed. */
function outcomeOf(item: InboxItemPayload): string | undefined {
  if (item.request && item.answer) return answerLine(item.request, item.answer);
  return item.closeReason;
}

function DoneRow(props: {
  expanded: boolean;
  item: InboxItemPayload;
  onToggle(): void;
  /** The Conversation title, when it is known. */
  title?: string;
}) {
  const { item } = props;
  const dismissed = item.status === "dismissed";
  const outcome = outcomeOf(item);
  const text =
    item.kind === "notice" || !item.request
      ? inboxItemText(item)
      : item.request.question;
  const regionId = `inbox-done-${item.id}`;
  const Icon = dismissed ? X : Check;
  return (
    <li
      className={inboxCardClass(props.expanded)}
      data-expanded={props.expanded || undefined}
    >
      <button
        aria-controls={regionId}
        aria-expanded={props.expanded}
        className={inboxRowButtonClass(props.expanded)}
        data-inbox-row={item.id}
        onClick={props.onToggle}
        type="button"
      >
        <Icon
          aria-hidden="true"
          className="mt-[0.25rem] size-3.5 text-dashboard-text-faint"
        />
        <span className="grid min-w-0 gap-0.5">
          <span
            className={cn(
              fadeOverflowClass,
              "font-display text-base font-medium leading-snug text-dashboard-text",
            )}
            ref={fadeWhenOverflowing}
          >
            <InboxItemTitle item={item} />
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 text-xs leading-tight text-dashboard-text-muted">
            {outcome ? (
              <span
                className={cn(fadeOverflowClass, "text-dashboard-text")}
                ref={fadeWhenOverflowing}
              >
                {outcome}
              </span>
            ) : null}
            <span className="shrink-0">
              {outcome ? "· " : ""}
              {/* The row is a button, which cannot hold a link. */}
              <InboxItemCloser card={false} item={item} />
            </span>
          </span>
        </span>
        <span className="flex items-center gap-1.5 pt-0.5 text-xs tabular-nums text-dashboard-text-faint">
          {dismissed ? (
            <span className="font-medium text-dashboard-text-muted">
              Dismissed
            </span>
          ) : null}
          {formatRelativeTime(item.closedAt ?? item.updatedAt)}
        </span>
      </button>
      {props.expanded ? (
        <div
          aria-label={`${inboxItemTitleText(item)}: how it closed`}
          className={cn(INBOX_ROW_DETAIL_CLASS, "gap-4 font-sans text-sm")}
          id={regionId}
          role="region"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-dashboard-border pb-3">
            <span
              className={cn(fadeOverflowClass, "text-dashboard-text-muted")}
              ref={fadeWhenOverflowing}
            >
              {props.title}
            </span>
            <Link
              className="ml-auto inline-flex items-center gap-1.5 font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
              to={itemOwnerPath(item, { askItemId: item.id })}
            >
              {itemOwnerLinkLabel(item)}
              <ArrowUpRight aria-hidden="true" size={14} />
            </Link>
          </div>
          <InboxItemObjects conversationId={itemConversationId(item)}>
            <DisplayText mentions={item.mentions} text={text} />
            {item.subject ? (
              <InboxItemSubjectPreview
                conversationId={itemConversationId(item)}
                subject={item.subject}
              />
            ) : null}
          </InboxItemObjects>
          {/* A closed item shows who closed it, when, and the answer. */}
          <InboxItemActions item={item} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Done: the closed Inbox items, newest closed first, in
 * Today, This week, and Earlier. It is read-only. A row expands in place;
 * only the link to its Conversation or Automation leaves the Inbox.
 */
export function InboxDoneView(props: {
  collapsed: ReadonlySet<string>;
  expandedKey?: string;
  items: readonly InboxItemPayload[];
  nowMs: number;
  onToggle(key: string): void;
  onToggleSection(key: string): void;
  titleOf(conversationId: string | undefined): string | undefined;
}) {
  return (
    <div className="grid">
      {doneSections(props.items, props.nowMs).map((section) => (
        <InboxSection
          collapsed={props.collapsed.has(`done:${section.key}`)}
          count={section.items.length}
          key={section.key}
          label={section.label}
          onToggle={() => props.onToggleSection(`done:${section.key}`)}
        >
          {section.items.map((item) => (
            <DoneRow
              expanded={item.id === props.expandedKey}
              item={item}
              key={item.id}
              onToggle={() => props.onToggle(item.id)}
              title={props.titleOf(itemConversationId(item))}
            />
          ))}
        </InboxSection>
      ))}
    </div>
  );
}
