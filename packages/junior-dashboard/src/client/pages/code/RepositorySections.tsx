import type { AutomationSummary } from "@sentry/junior/api/schema";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";

import { Card } from "../../components/layout/Card";
import { SectionHeader } from "../../components/layout/SectionHeader";
import { SectionTitle } from "../../components/layout/SectionTitle";
import { ConversationSidebarAnnotations } from "../../conversations/ConversationMeta";
import { ConversationListStatusIcon } from "../../conversations/ConversationListStatusIcon";
import { conversationPath } from "../../conversations/conversationRoutes";
import {
  automationPath,
  conversationDisplayTitle,
  formatRelativeTime,
  slackLocationLabel,
  visualStatusForConversation,
} from "../../format";
import type { Conversation } from "../../types";
import { AutomationRow } from "../automations/AutomationRow";

/** Titled repository card with an optional "View all" link to its tab. */
export function RepositorySection(props: {
  children: ReactNode;
  title: string;
  viewAllTo?: string;
}) {
  return (
    <Card as="section" className="mb-0" variant="section">
      <SectionHeader
        actions={
          props.viewAllTo ? (
            <Link
              className="text-sm text-dashboard-text underline underline-offset-2"
              to={props.viewAllTo}
            >
              View all
            </Link>
          ) : undefined
        }
      >
        <SectionTitle>{props.title}</SectionTitle>
      </SectionHeader>
      {props.children}
    </Card>
  );
}

/**
 * Two-line conversation row built from the sidebar row parts: status icon and
 * title, then plugin annotations or the location.
 */
export function RecentConversationRow(props: { conversation: Conversation }) {
  const conversation = props.conversation;
  const title = conversationDisplayTitle(conversation);
  const location = slackLocationLabel(conversation, { includeId: false });
  const hasAnnotations = Boolean(conversation.sidebarAnnotations?.length);
  return (
    <div className="relative min-w-0 border-b border-dashboard-border-subtle px-4 py-3 transition-colors last:border-b-0 hover:bg-dashboard-fill-soft">
      <Link
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-dashboard-focus"
        to={conversationPath(conversation.id)}
      />
      <div className="pointer-events-none relative z-[1] grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2">
        <span className="mt-1.5 grid size-3 shrink-0 place-items-center">
          <ConversationListStatusIcon
            finishedSinceSeen={false}
            isPrivate={conversation.visibility === "private"}
            status={visualStatusForConversation(conversation)}
          />
        </span>
        <div className="min-w-0 truncate font-display text-sm text-dashboard-text">
          {title}
        </div>
        <span className="whitespace-nowrap font-mono text-xs text-dashboard-text-muted">
          {formatRelativeTime(conversation.lastSeenAt)}
        </span>
        {/* Keep the meta line at text height so annotation chips do not make
            this row taller than a code change row beside it. */}
        <div className="col-start-2 col-end-4 mt-1 flex h-4 min-w-0 items-center gap-1.5 font-mono text-xs text-dashboard-text-muted">
          {hasAnnotations ? (
            <ConversationSidebarAnnotations
              annotations={conversation.sidebarAnnotations}
            />
          ) : location ? (
            <span className="truncate">{location}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Automation cards that open the automation, where its runs live. Delete is
 * not offered here, so the row delete action is a no-op.
 */
export function RepositoryAutomationList(props: {
  automations: AutomationSummary[];
}) {
  const navigate = useNavigate();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2" role="list">
      {props.automations.map((automation) => (
        <AutomationRow
          automation={automation}
          deleting={false}
          key={`${automation.kind}:${automation.id}`}
          onDelete={() => undefined}
          onSelect={() => navigate(automationPath(automation.id))}
          selected={false}
        />
      ))}
    </div>
  );
}
