import { ArrowLeft, CornerLeftUp } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  ConversationAgentTreeNode,
  ConversationDetailReport,
} from "@sentry/junior/api/schema";

import { DetailsPanel, useDetailsPanel } from "../../components/DetailsPanel";
import { ConversationInboxItems } from "../inbox/ConversationInboxItems";
import { Button } from "../../components/ui/button";
import { ConversationSummary } from "../../conversations/ConversationSummary";
import {
  ConversationTasks,
  ConversationThreads,
  useConversationChildAgents,
} from "../../conversations/ConversationChildAgents";
import { conversationPath } from "../../conversations/conversationRoutes";
import {
  ConversationLinkedWorkCard,
  type ConversationLink,
} from "../../conversations/ConversationLinkedWork";
import {
  ConversationMemoryCard,
  ConversationMemoryEntries,
} from "../../conversations/ConversationMemories";
import {
  conversationMemoryEntries,
  type ConversationMemoryEntry,
  type ConversationMemoryList,
} from "../../conversations/conversationMemory";
import { ConversationTodos } from "../../conversations/ConversationTodos";
import { DetailsCard, DetailsRow } from "../../conversations/DetailsList";
import type { ConversationDrawerTarget } from "../../conversations/ConversationDrawer";
import { fadeOverflowClass, fadeWhenOverflowing } from "../../textFade";
import { cn } from "../../styles";

/**
 * Lead with the glance (cost, repository, location), then the summary, the
 * work that needs the reader, and linked work. Reference facts come last.
 */
export function ConversationDetails(props: {
  /** Parent chain of a child Conversation, root first, this one last. */
  agentTree?: readonly ConversationAgentTreeNode[] | undefined;
  conversationId: string;
  /** Live cost, repository, and location, above everything else. */
  glance: ReactNode;
  summary?: string | undefined;
  summaryMentions?: ConversationDetailReport["summaryMentions"];
  /** True when a sidebar review chip opened details. */
  highlightReview: boolean;
  identity: ReactNode;
  /**
   * True when the viewer is a Participant, who can change To-dos and cancel
   * Watches.
   */
  isParticipant: boolean;
  links: ConversationLink[];
  memoryList?: ConversationMemoryList | undefined;
  onClose(): void;
  /** Open one Task transcript. A details sheet closes first. */
  onOpenSubagent(target: ConversationDrawerTarget): void;
  /** Show the Turn that recalled or captured one memory. */
  onSelectMemory(entry: ConversationMemoryEntry): void;
  overview: ReactNode;
  usage: ReactNode;
}) {
  const panel = useDetailsPanel();
  const { memoryList } = props;
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [memoryConversationId, setMemoryConversationId] = useState(
    props.conversationId,
  );
  if (memoryConversationId !== props.conversationId) {
    setMemoryConversationId(props.conversationId);
    setMemoriesOpen(false);
  }
  const agents = useConversationChildAgents(props.conversationId).data?.agents;
  const threads = agents?.filter((agent) => agent.kind === "thread") ?? [];
  const tasks = agents?.filter((agent) => agent.kind === "task") ?? [];
  // The last node is this Conversation, so the one before it is the parent.
  const parent = props.agentTree?.at(-2);

  if (memoriesOpen && memoryList) {
    // The list replaces details in place, so nothing stacks over the panel.
    return (
      <DetailsPanel
        label="Conversation details"
        onClose={props.onClose}
        title={
          <div className="-ml-2 flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              aria-label="Back to details"
              onClick={() => setMemoriesOpen(false)}
              size="icon"
            >
              <ArrowLeft aria-hidden="true" size={15} />
            </Button>
            <h2
              className={cn(
                fadeOverflowClass,
                "m-0 font-sans text-sm font-semibold text-dashboard-text",
              )}
              ref={fadeWhenOverflowing}
            >
              Memories
            </h2>
          </div>
        }
      >
        <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <ConversationMemoryEntries
            entries={conversationMemoryEntries(memoryList)}
            onSelect={(entry) => {
              // The transcript sits under a details sheet. Close it first.
              if (!panel) props.onClose();
              props.onSelectMemory(entry);
            }}
          />
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
      <div className="grid min-w-0 content-start gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {props.glance}
        {/* What the work is and where it stands. */}
        {props.summary ? (
          <section
            aria-label="Summary"
            className="min-w-0 break-words px-1 pb-1 font-sans text-sm leading-relaxed text-dashboard-text-muted"
            id="conversation-summary"
          >
            <ConversationSummary
              mentions={props.summaryMentions}
              summary={props.summary}
            />
          </section>
        ) : null}
        {parent ? (
          <DetailsCard title="Parent">
            <DetailsRow
              icon={<CornerLeftUp aria-hidden="true" size={14} />}
              title={parent.label}
              to={conversationPath(parent.conversationId)}
            />
          </DetailsCard>
        ) : null}
        <ConversationInboxItems
          conversationId={props.conversationId}
          highlight={props.highlightReview}
        />
        <ConversationTodos
          canEdit={props.isParticipant}
          conversationId={props.conversationId}
        />
        {threads.length > 0 ? <ConversationThreads threads={threads} /> : null}
        <ConversationLinkedWorkCard
          canCancelWatches={props.isParticipant}
          conversationId={props.conversationId}
          links={props.links}
        />
        {tasks.length > 0 ? (
          <ConversationTasks
            onOpenTask={(target) => {
              // The panel stays beside the drawer. A modal sheet cannot.
              if (!panel) props.onClose();
              props.onOpenSubagent(target);
            }}
            tasks={tasks}
          />
        ) : null}
        {props.identity != null ? (
          <DetailsCard title="Participants">{props.identity}</DetailsCard>
        ) : null}
        {props.usage}
        {props.overview != null ? (
          <DetailsCard>{props.overview}</DetailsCard>
        ) : null}
        {memoryList?.events.length ? (
          <ConversationMemoryCard
            list={memoryList}
            onOpen={() => setMemoriesOpen(true)}
          />
        ) : null}
      </div>
    </DetailsPanel>
  );
}
