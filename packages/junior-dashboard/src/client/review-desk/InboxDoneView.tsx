import { ArrowUpRight, Check, X } from "lucide-react";
import { Link } from "react-router";
import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import { conversationPath } from "../conversations/conversationRoutes";
import { DisplayText } from "../display-text/DisplayText";
import { formatRelativeTime } from "../format";
import { inboxCardClass, inboxRowButtonClass } from "./InboxBundleView";
import { InboxSection } from "./InboxSection";
import { doneSections } from "./inboxModel";
import { ReviewItemActions } from "./ReviewItemActions";
import { ReviewItemSubjectPreview } from "./ReviewItemSubjectPreview";
import { answerLine } from "./reviewItemFormat";

/** The answer, or the reason that the item closed. */
function outcomeOf(item: ReviewItemPayload): string | undefined {
  if (item.request && item.answer) return answerLine(item.request, item.answer);
  return item.closeReason;
}

function DoneRow(props: {
  active: boolean;
  expanded: boolean;
  item: ReviewItemPayload;
  onActivate(): void;
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
  const regionId = `inbox-done-${item.id}`;
  const Icon = dismissed ? X : Check;
  return (
    <li className={inboxCardClass(props.expanded)} onFocus={props.onActivate}>
      <button
        aria-controls={regionId}
        aria-expanded={props.expanded}
        className={inboxRowButtonClass(props.active, props.expanded)}
        data-inbox-bundle={item.id}
        onClick={props.onToggle}
        tabIndex={props.active ? 0 : -1}
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
          className="grid min-w-0 gap-4 px-4 pb-4 font-sans text-sm md:px-6"
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
          <DisplayText
            text={
              item.kind === "notice" || !item.request
                ? item.body
                : item.request.question
            }
          />
          {item.subject ? (
            <ReviewItemSubjectPreview
              conversationId={item.addedByConversationId}
              subject={item.subject}
            />
          ) : null}
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
  activeKey?: string;
  collapsed: ReadonlySet<string>;
  expandedKey?: string;
  items: readonly ReviewItemPayload[];
  nowMs: number;
  onActivate(key: string): void;
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
              active={item.id === props.activeKey}
              expanded={item.id === props.expandedKey}
              item={item}
              key={item.id}
              onActivate={() => props.onActivate(item.id)}
              onToggle={() => props.onToggle(item.id)}
              title={props.titleOf(item.addedByConversationId)}
            />
          ))}
        </InboxSection>
      ))}
    </div>
  );
}

/** The keys of the Done rows in reading order, for keyboard moves. */
export function doneKeys(
  items: readonly ReviewItemPayload[],
  nowMs: number,
  collapsed: ReadonlySet<string>,
): string[] {
  return doneSections(items, nowMs).flatMap((section) =>
    collapsed.has(`done:${section.key}`)
      ? []
      : section.items.map((item) => item.id),
  );
}
