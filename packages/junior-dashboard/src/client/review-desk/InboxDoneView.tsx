import { ArrowUpRight, Check, X } from "lucide-react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { conversationPath } from "../conversations/conversationRoutes";
import { DisplayText } from "../display-text/DisplayText";
import { formatRelativeTime } from "../format";
import { cn } from "../styles";
import {
  INBOX_ROW_DETAIL_CLASS,
  inboxCardClass,
  inboxRowButtonClass,
} from "./inboxRowStyles";
import { InboxSection } from "./InboxSection";
import { doneSections } from "./inboxModel";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemObjects } from "./ReviewItemObjects";
import { ReviewItemSubjectPreview } from "./ReviewItemSubjectPreview";
import { answerLine } from "./reviewItemFormat";

/** The answer, or the reason that the item closed. */
function outcomeOf(item: ReviewItemPayload): string | undefined {
  if (item.request && item.answer) return answerLine(item.request, item.answer);
  return item.closeReason;
}

function DoneRow(props: {
  expanded: boolean;
  item: ReviewItemPayload;
  onToggle(): void;
  /** The Conversation title, when it is known. */
  title?: string;
}) {
  const { item } = props;
  const dismissed = item.status === "dismissed";
  const closedBy = item.closedBy
    ? (item.closedBy.displayName ?? item.closedBy.email)
    : "An agent";
  const outcome = outcomeOf(item);
  const text =
    item.kind === "notice" || !item.request ? item.body : item.request.question;
  const regionId = `inbox-done-${item.id}`;
  const Icon = dismissed ? X : Check;
  return (
    <li className={inboxCardClass(props.expanded)}>
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
          className="mt-[0.2rem] size-3.5 text-dashboard-text-faint"
        />
        <span className="grid min-w-0 gap-0.5">
          <span className="min-w-0 truncate text-sm font-medium leading-snug text-dashboard-text">
            {item.title}
          </span>
          <span className="flex min-w-0 items-baseline gap-1.5 text-xs leading-tight text-dashboard-text-muted">
            {outcome ? (
              <span className="min-w-0 truncate text-dashboard-text">
                {outcome}
              </span>
            ) : null}
            <span className="shrink-0">
              {outcome ? "· " : ""}
              {closedBy}
            </span>
          </span>
        </span>
        <span className="flex items-center gap-1.5 pt-0.5 text-xs tabular-nums text-dashboard-text-faint">
          {dismissed ? (
            <span className="rounded-full border border-dashboard-border px-1.5 font-medium text-dashboard-text-muted">
              Dismissed
            </span>
          ) : null}
          {formatRelativeTime(item.closedAt ?? item.updatedAt)}
        </span>
      </button>
      {props.expanded ? (
        <div
          aria-label={`${item.title}: how it closed`}
          className={cn(INBOX_ROW_DETAIL_CLASS, "gap-4 font-sans text-sm")}
          id={regionId}
          role="region"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-dashboard-border pb-3">
            <span className="min-w-0 truncate text-dashboard-text-muted">
              {props.title}
            </span>
            <Link
              className="ml-auto inline-flex items-center gap-1.5 font-medium text-dashboard-text no-underline hover:underline focus-visible:outline-dashboard-focus"
              to={conversationPath(item.addedByConversationId, {
                turnId: item.addedByTurnId,
              })}
            >
              Open conversation
              <ArrowUpRight aria-hidden="true" size={14} />
            </Link>
          </div>
          <ReviewItemObjects conversationId={item.addedByConversationId}>
            <DisplayText text={text} />
            {item.subject ? (
              <ReviewItemSubjectPreview
                body={text}
                conversationId={item.addedByConversationId}
                subject={item.subject}
              />
            ) : null}
          </ReviewItemObjects>
          {/* A closed item shows who closed it, when, and the answer. */}
          <ReviewItemActions item={item} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Done: the closed Review items of the Inbox, newest closed first, in
 * Today, This week, and Earlier. It is read-only. A row expands in place;
 * only "Open conversation" leaves the Inbox.
 */
export function InboxDoneView(props: {
  collapsed: ReadonlySet<string>;
  expandedKey?: string;
  items: readonly ReviewItemPayload[];
  nowMs: number;
  onToggle(key: string): void;
  onToggleSection(key: string): void;
  titleOf(conversationId: string): string | undefined;
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
              title={props.titleOf(item.addedByConversationId)}
            />
          ))}
        </InboxSection>
      ))}
    </div>
  );
}
