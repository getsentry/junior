import { Bot, CornerLeftUp, Zap, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  ActorIdentity,
  ConversationDetailReport,
} from "@sentry/junior/api/schema";

import { DetailsPanel, useDetailsPanel } from "../../components/DetailsPanel";
import { Button } from "../../components/ui/button";
import {
  ConversationInboxItems,
  useConversationNeedsYou,
} from "../inbox/ConversationInboxItems";
import { ConversationSummary } from "../../conversations/ConversationSummary";
import { conversationPath } from "../../conversations/conversationRoutes";
import {
  ConversationLinkedWork,
  type ConversationLink,
} from "../../conversations/ConversationLinkedWork";
import { ConversationMemoryEntries } from "../../conversations/ConversationMemories";
import {
  conversationMemoryEntries,
  type ConversationMemoryEntry,
  type ConversationMemoryList,
} from "../../conversations/conversationMemory";
import { ConversationParticipants } from "../../conversations/ConversationParticipants";
import { ConversationAgents } from "../../conversations/ConversationAgents";
import { ConversationTodoList } from "../../conversations/ConversationTodos";
import { ConversationWaitingOn } from "../../conversations/ConversationWatches";
import {
  ConversationDrawer,
  type ConversationDrawerTarget,
} from "../../conversations/ConversationDrawer";
import { automationPath } from "../../format";
import { useMobileLayout } from "../../layoutMedia";
import { fadeOverflowClass, fadeWhenOverflowing } from "../../textFade";
import { cn } from "../../styles";

type DetailsView = "details" | "memories" | "usage";

const viewTitles: Record<Exclude<DetailsView, "details">, string> = {
  memories: "Memories",
  usage: "Usage",
};

/**
 * Show what a Conversation is and where its work stands, top to bottom:
 * where it came from, the summary, what needs the viewer, its Agents,
 * To-dos, and what it waits on, and its linked work. The footer holds the
 * Participants, the cost, and Usage and Memories, which open in place of
 * the details.
 */
export function ConversationDetails(props: {
  conversationId: string;
  /** The repository and Slack location line under the summary. */
  context: ReactNode;
  /** The estimated cost, or null before there is one. */
  cost: ReactNode;
  detail: ConversationDetailReport | undefined;
  /** True when a sidebar review chip opened details. */
  highlightReview: boolean;
  links: ConversationLink[];
  memoryList?: ConversationMemoryList | undefined;
  onClose(): void;
  /**
   * Open one Task transcript. A details sheet closes first. A phone opens
   * the Task in a sheet over details instead, so this does not run there.
   */
  onOpenSubagent(target: ConversationDrawerTarget): void;
  /** Show the Turn that recalled or captured one memory. */
  onSelectMemory(entry: ConversationMemoryEntry): void;
  participants: readonly ActorIdentity[];
  /** The one GitHub repository of the linked work, for short refs. */
  repository?: string | undefined;
  /** The Usage view: totals and the breakdown. Null when it has none. */
  usage: ReactNode;
}) {
  const { detail, memoryList } = props;
  const panel = useDetailsPanel();
  const mobile = useMobileLayout();
  const [task, setTask] = useState<ConversationDrawerTarget>();
  const [view, setView] = useState<DetailsView>("details");
  const [viewConversationId, setViewConversationId] = useState(
    props.conversationId,
  );
  if (viewConversationId !== props.conversationId) {
    setViewConversationId(props.conversationId);
    setView("details");
    setTask(undefined);
  }
  const needsYou = useConversationNeedsYou(props.conversationId);
  // Items kept from the last Conversation must not hide this one's To-dos.
  const needsYouTodoIds = new Set(
    needsYou.query.isPlaceholderData
      ? []
      : needsYou.items.flatMap((item) =>
          item.todoId === undefined ? [] : [item.todoId],
        ),
  );
  const canEdit = detail?.isParticipant === true;
  const hasMemories = Boolean(memoryList?.events.length);
  const origin = conversationOrigin(detail);

  if (
    (view === "usage" && props.usage) ||
    (view === "memories" && memoryList && hasMemories)
  ) {
    // The view replaces details in place, so nothing stacks over the panel.
    const title = viewTitles[view];
    return (
      <DetailsPanel
        back={{
          label: "Back to details",
          onBack: () => setView("details"),
        }}
        label="Conversation details"
        onClose={props.onClose}
        sheetTitle={title}
        title={
          <h2
            className={cn(
              fadeOverflowClass,
              "m-0 font-sans text-sm font-semibold text-dashboard-text",
            )}
            ref={fadeWhenOverflowing}
          >
            {title}
          </h2>
        }
      >
        <div
          className={cn(
            "grid min-w-0 content-start gap-6 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3",
            bodyInset(panel),
          )}
        >
          {view === "usage" ? (
            props.usage
          ) : memoryList ? (
            <ConversationMemoryEntries
              entries={conversationMemoryEntries(memoryList)}
              onSelect={(entry) => {
                // The transcript sits under a details sheet. Close it first.
                if (!panel) props.onClose();
                props.onSelectMemory(entry);
              }}
            />
          ) : null}
        </div>
      </DetailsPanel>
    );
  }

  return (
    <DetailsPanel
      label="Conversation details"
      title={
        <h2
          aria-label="Conversation details"
          className="m-0 flex min-w-0 items-center gap-1.5 font-sans text-sm"
        >
          <span className="font-semibold text-dashboard-text">Details</span>
        </h2>
      }
      onClose={props.onClose}
    >
      <div
        className={cn(
          "grid min-w-0 content-start gap-8 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3",
          bodyInset(panel),
        )}
      >
        {origin || detail?.summary || props.context ? (
          <div className="grid min-w-0 gap-2">
            {origin ? <ConversationOrigin origin={origin} /> : null}
            {detail?.summary ? (
              <section
                aria-label="Summary"
                className="min-w-0 break-words font-sans text-sm leading-relaxed text-dashboard-text-subtle"
                id="conversation-summary"
              >
                <ConversationSummary
                  mentions={detail?.summaryMentions}
                  summary={detail.summary}
                />
              </section>
            ) : null}
            {props.context}
          </div>
        ) : null}
        <ConversationInboxItems
          conversationId={props.conversationId}
          highlight={props.highlightReview}
        />
        {/* A key per Conversation resets "Show finished". */}
        <ConversationAgents
          canEdit={canEdit}
          conversationId={props.conversationId}
          events={detail?.events}
          key={`agents:${props.conversationId}`}
          onOpenTask={(target) => {
            // A phone shows the Task one step deeper in the details sheet.
            if (mobile) return setTask(target);
            // The panel stays beside the drawer. A modal sheet cannot.
            if (!panel) props.onClose();
            props.onOpenSubagent(target);
          }}
        />
        <ConversationTodoList
          canEdit={canEdit}
          conversationId={props.conversationId}
          key={`todos:${props.conversationId}`}
          needsYouTodoIds={needsYouTodoIds}
        />
        <ConversationWaitingOn
          canEdit={canEdit}
          conversationId={props.conversationId}
        />
        <ConversationLinkedWork
          key={`links:${props.conversationId}`}
          links={props.links}
          repository={props.repository}
        />
        <ConversationParticipants
          conversationId={props.conversationId}
          detail={detail}
          participants={props.participants}
          trailing={
            <div className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-dashboard-text-muted">
              {props.cost ? <span className="px-1.5">{props.cost}</span> : null}
              {props.usage ? (
                <FooterButton onClick={() => setView("usage")}>
                  Usage
                </FooterButton>
              ) : null}
              {hasMemories ? (
                <FooterButton onClick={() => setView("memories")}>
                  Memories
                </FooterButton>
              ) : null}
            </div>
          }
        />
      </div>
      {task ? (
        <ConversationDrawer
          icon={
            <Bot
              aria-hidden="true"
              className="shrink-0 text-dashboard-text-muted"
              size={16}
              strokeWidth={2}
            />
          }
          onClose={() => setTask(undefined)}
          target={task}
        />
      ) : null}
    </DetailsPanel>
  );
}

function FooterButton(props: { children: ReactNode; onClick(): void }) {
  return (
    <Button
      className="rounded-md px-1.5 py-0.5 text-xs text-dashboard-text-muted hover:text-dashboard-text"
      onClick={props.onClick}
      size="bare"
      variant="ghost"
    >
      {props.children}
    </Button>
  );
}

type ConversationOriginLink = {
  icon: LucideIcon;
  /** What the link is, for a screen reader, such as "Parent". */
  kind: string;
  label: string;
  to?: string;
};

/**
 * Find where a Conversation came from: the parent of a child Conversation,
 * or the Automation that started it.
 */
function conversationOrigin(
  detail: ConversationDetailReport | undefined,
): ConversationOriginLink | undefined {
  // The last node is this Conversation, so the one before it is the parent.
  const parent = detail?.agentTree?.at(-2);
  if (parent) {
    return {
      icon: CornerLeftUp,
      kind: "Parent",
      label: parent.label,
      to: conversationPath(parent.conversationId),
    };
  }
  const sourceTask = detail?.sourceTask;
  if (!sourceTask) return undefined;
  const automationId = sourceTask.id?.trim();
  return {
    icon: Zap,
    kind: "Automation",
    label: sourceTask.title?.trim() || "Automation",
    ...(automationId ? { to: automationPath(automationId) } : undefined),
  };
}

// The panel header starts its title 20px in, and the phone sheet 16px in.
// The body text starts on the same edge.
function bodyInset(panel: boolean) {
  return panel ? "px-5" : "px-4";
}

/** Name where a Conversation came from in one muted line. */
function ConversationOrigin(props: { origin: ConversationOriginLink }) {
  const { origin } = props;
  const Icon = origin.icon;
  const content = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className={fadeOverflowClass} ref={fadeWhenOverflowing}>
        {origin.label}
      </span>
    </>
  );
  const className =
    "flex min-w-0 items-center gap-1.5 text-xs leading-5 text-dashboard-text-muted";
  return origin.to ? (
    <Link
      aria-label={`${origin.kind}: ${origin.label}`}
      className={cn(className, "w-fit max-w-full hover:text-dashboard-text")}
      to={origin.to}
    >
      {content}
    </Link>
  ) : (
    <p className={cn(className, "m-0")}>{content}</p>
  );
}
