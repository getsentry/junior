import { ArrowLeft } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { DetailsPanel, useDetailsPanel } from "../components/DetailsPanel";
import { formatRelativeTime, formatTime } from "../format";
import { ConversationReviewItems } from "../review-desk/ConversationReviewItems";
import { Button } from "../components/ui/button";
import { ConversationBrief } from "./ConversationBrief";
import {
  ConversationChildAgents,
  useConversationChildAgents,
} from "./ConversationChildAgents";
import {
  ConversationLinkedWork,
  type ConversationLink,
} from "./ConversationLinkedWork";
import {
  ConversationMemoryCard,
  ConversationMemoryEntries,
} from "./ConversationMemories";
import {
  conversationMemoryEntries,
  useConversationMemoryState,
  type ConversationMemoryEntry,
} from "./conversationMemory";
import {
  ConversationWatches,
  useConversationWatches,
} from "./ConversationWatches";
import { DetailsCard } from "./DetailsList";
import type { SubagentTranscriptTarget } from "./SubagentTranscriptDrawer";

type Brief = NonNullable<ConversationDetailReport["brief"]>;

/**
 * Show conversation details in the order a reader asks about them: what the
 * work is (the Brief), what needs them, what it changed or waits on, who did
 * it, and what it cost. Each fact shows here only, not in the title bar.
 */
export function ConversationDetails(props: {
  brief?: Brief;
  conversationId: string;
  /** True when a sidebar review chip opened details. */
  highlightReview: boolean;
  identity: ReactNode;
  links: ConversationLink[];
  onClose(): void;
  /** Open one child agent transcript. A details sheet closes first. */
  onOpenSubagent(target: SubagentTranscriptTarget): void;
  /** Show one memory where its Turn recalled or captured it. */
  onSelectMemory(entry: ConversationMemoryEntry & { turnId: string }): void;
  /** The prompt that started each loaded Turn. */
  memoryPrompts: Map<string, string>;
  overview: ReactNode;
  usage: ReactNode;
}) {
  const panel = useDetailsPanel();
  const memoryList = useConversationMemoryState()?.list;
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [memoryConversationId, setMemoryConversationId] = useState(
    props.conversationId,
  );
  if (memoryConversationId !== props.conversationId) {
    setMemoryConversationId(props.conversationId);
    setMemoriesOpen(false);
  }
  const agents = useConversationChildAgents(props.conversationId).data?.agents;
  const watches =
    useConversationWatches(props.conversationId).data?.watches ?? [];

  if (memoriesOpen && memoryList) {
    // The list replaces details in place, so nothing stacks over the panel.
    return (
      <DetailsPanel
        label="Conversation details"
        onClose={props.onClose}
        title={
          <div className="-ml-2 flex min-w-0 items-center gap-1">
            <Button
              aria-label="Back to details"
              onClick={() => setMemoriesOpen(false)}
              size="icon"
            >
              <ArrowLeft aria-hidden="true" size={15} />
            </Button>
            <h2 className="m-0 truncate font-sans text-sm font-semibold text-dashboard-text">
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
            prompts={props.memoryPrompts}
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
          {props.brief ? (
            <>
              <span className="font-semibold text-dashboard-text">Brief</span>
              <span aria-hidden="true" className="text-dashboard-text-faint">
                ·
              </span>
              <time
                className="truncate font-normal text-dashboard-text-muted"
                dateTime={props.brief.updatedAt}
                title={formatTime(props.brief.updatedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              >
                Updated {formatRelativeTime(props.brief.updatedAt)}
              </time>
            </>
          ) : (
            <span className="font-semibold text-dashboard-text">Details</span>
          )}
        </h2>
      }
      onClose={props.onClose}
    >
      <div className="grid min-w-0 content-start gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {props.brief ? (
          <div className="min-w-0 break-words px-1 pb-1 font-sans text-sm leading-relaxed text-dashboard-text-muted">
            <ConversationBrief brief={props.brief} variant="summary" />
          </div>
        ) : null}
        <ConversationReviewItems
          conversationId={props.conversationId}
          highlight={props.highlightReview}
        />
        {props.links.length > 0 || watches.length > 0 ? (
          // A Watch waits on something. It shows with linked work, so the
          // work and what Junior waits on read as one list.
          <DetailsCard
            count={props.links.length || watches.length}
            title={props.links.length > 0 ? "Linked work" : "Waiting on"}
          >
            {props.links.length > 0 ? (
              <ConversationLinkedWork links={props.links} />
            ) : null}
            {props.links.length > 0 && watches.length > 0 ? (
              <h4 className="m-0 mb-1.5 mt-3 font-sans text-xs font-medium text-dashboard-text-faint">
                Also waiting on
              </h4>
            ) : null}
            {watches.length > 0 ? (
              <ConversationWatches watches={watches} />
            ) : null}
          </DetailsCard>
        ) : null}
        {agents?.length ? (
          <DetailsCard count={agents.length} title="Subagents">
            <ConversationChildAgents
              conversationId={props.conversationId}
              onOpenAgent={(target) => {
                // The panel stays beside the drawer. A modal sheet cannot.
                if (!panel) props.onClose();
                props.onOpenSubagent(target);
              }}
            />
          </DetailsCard>
        ) : null}
        {props.overview != null ? (
          <DetailsCard>{props.overview}</DetailsCard>
        ) : null}
        {props.usage != null ? (
          <DetailsCard title="Usage">{props.usage}</DetailsCard>
        ) : null}
        {props.identity != null ? (
          <DetailsCard title="Participants">{props.identity}</DetailsCard>
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
