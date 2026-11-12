import { ArrowLeft, CornerLeftUp } from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  ConversationAgentTreeNode,
  ConversationDetailReport,
  ConversationWatch,
} from "@sentry/junior/api/schema";

import { DetailsPanel, useDetailsPanel } from "../components/DetailsPanel";
import { formatRelativeTime, formatTime } from "../format";
import { ConversationReviewItems } from "../review-desk/ConversationReviewItems";
import { Button } from "../components/ui/button";
import { ConversationBrief } from "./ConversationBrief";
import {
  ConversationTasks,
  ConversationThreads,
  useConversationChildAgents,
} from "./ConversationChildAgents";
import { conversationPath } from "./conversationRoutes";
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
import { DetailsCard, DetailsRow } from "./DetailsList";
import type { ConversationDrawerTarget } from "./ConversationDrawer";

type Brief = NonNullable<ConversationDetailReport["brief"]>;

/**
 * Surface work that needs the reader, then the Brief and its linked work.
 */
export function ConversationDetails(props: {
  /** Parent chain of a child Conversation, root first, this one last. */
  agentTree?: readonly ConversationAgentTreeNode[];
  /** Viewer's auto-archive control. Null for non-participants. */
  autoArchive: ReactNode;
  brief?: Brief;
  conversationId: string;
  /** True when a sidebar review chip opened details. */
  highlightReview: boolean;
  identity: ReactNode;
  links: ConversationLink[];
  onClose(): void;
  /** Open one Task transcript. A details sheet closes first. */
  onOpenSubagent(target: ConversationDrawerTarget): void;
  /** Show one memory where its Turn recalled or captured it. */
  onSelectMemory(entry: ConversationMemoryEntry & { turnId: string }): void;
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
  const threads = agents?.filter((agent) => agent.kind === "thread") ?? [];
  const tasks = agents?.filter((agent) => agent.kind === "task") ?? [];
  // The last node is this Conversation, so the one before it is the parent.
  const parent = props.agentTree?.at(-2);
  const allWatches =
    useConversationWatches(props.conversationId).data?.watches ?? [];
  // A Watch on linked work shows in that row, so the resource shows once.
  const linkUrls = new Set(props.links.map((link) => link.url));
  const watchesByUrl = new Map<string, ConversationWatch[]>();
  const watches: ConversationWatch[] = [];
  for (const watch of allWatches) {
    if (watch.url && linkUrls.has(watch.url)) {
      watchesByUrl.set(watch.url, [
        ...(watchesByUrl.get(watch.url) ?? []),
        watch,
      ]);
    } else {
      watches.push(watch);
    }
  }

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
                className="truncate text-xs font-normal text-dashboard-text-muted"
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
      <div className="grid min-w-0 content-start gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {parent ? (
          <DetailsCard flat title="Parent">
            <DetailsRow
              icon={<CornerLeftUp aria-hidden="true" size={14} />}
              title={parent.label}
              to={conversationPath(parent.conversationId)}
            />
          </DetailsCard>
        ) : null}
        <ConversationReviewItems
          conversationId={props.conversationId}
          highlight={props.highlightReview}
        />
        {props.brief ? (
          <div className="min-w-0 break-words px-1 pb-1 font-sans text-sm leading-relaxed text-dashboard-text-muted">
            <ConversationBrief brief={props.brief} variant="summary" />
          </div>
        ) : null}
        {threads.length > 0 ? <ConversationThreads threads={threads} /> : null}
        {props.links.length > 0 || watches.length > 0 ? (
          // A Watch waits on something. It shows with linked work, so the
          // work and what Junior waits on read as one list.
          <DetailsCard
            count={props.links.length || watches.length}
            flat
            title={props.links.length > 0 ? "Linked work" : "Waiting on"}
          >
            {props.links.length > 0 ? (
              <ConversationLinkedWork
                links={props.links}
                watchesByUrl={watchesByUrl}
              />
            ) : null}
            {props.links.length > 0 && watches.length > 0 ? (
              <h4 className="m-0 mb-1.5 mt-3 font-sans text-xs font-semibold text-dashboard-text-muted">
                Also waiting on
              </h4>
            ) : null}
            {watches.length > 0 ? (
              <ConversationWatches watches={watches} />
            ) : null}
          </DetailsCard>
        ) : null}
        {/* Linked work decides when auto-archive runs, so it follows. */}
        {props.autoArchive != null ? (
          <DetailsCard>{props.autoArchive}</DetailsCard>
        ) : null}
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
        {props.overview != null ? (
          <DetailsCard flat>{props.overview}</DetailsCard>
        ) : null}
        {props.usage}
        {props.identity != null ? (
          <DetailsCard flat title="Participants">
            {props.identity}
          </DetailsCard>
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
