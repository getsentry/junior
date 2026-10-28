import { ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";

import { IconButtonTooltip } from "../components/Tooltip";
import {
  ConversationDetailsFrame,
  useConversationDetailsPanel,
} from "./ConversationDetailsFrame";
import { SegmentedTabs } from "../components/SegmentedTabs";
import {
  ConversationChildAgents,
  useConversationChildAgents,
} from "./ConversationChildAgents";
import {
  ConversationMemories,
  useConversationMemories,
} from "./ConversationMemories";
import { ShareConversationButton } from "./ShareConversationButton";
import type { SubagentTranscriptTarget } from "./SubagentTranscriptDrawer";

type DetailsTab = "agents" | "summary" | "memories";

/**
 * Show conversation details: the brief and facts first, then linked work,
 * participants, and the usage breakdown. Share and Sentry links stay in the
 * header so every tab can reach them.
 */
export function ConversationDetails(props: {
  annotations: ReactNode;
  brief: ReactNode;
  conversationId: string;
  identity: ReactNode;
  onClose(): void;
  /** Open one child agent transcript. A details sheet closes first. */
  onOpenSubagent(target: SubagentTranscriptTarget): void;
  overview: ReactNode;
  sentryConversationUrl?: string;
  usage: ReactNode;
}) {
  const [tab, setTab] = useState<DetailsTab>("summary");
  const panel = useConversationDetailsPanel();
  // Load both lists with details so each tab can show its count.
  const memories = useConversationMemories(props.conversationId);
  const agents = useConversationChildAgents(props.conversationId);
  const tabs = [
    { label: "Summary", value: "summary" },
    {
      count: memories.data?.memories.length,
      label: "Memories",
      value: "memories",
    },
    { count: agents.data?.agents.length, label: "Subagents", value: "agents" },
  ] as const;

  const sections = [
    { content: props.overview, key: "overview", title: undefined },
    { content: props.identity, key: "participants", title: "Participants" },
    { content: props.annotations, key: "linked-work", title: "Linked work" },
    { content: props.usage, key: "usage", title: "Usage" },
  ].filter((section) => section.content != null);

  return (
    <ConversationDetailsFrame
      actions={
        <>
          <ShareConversationButton
            key={props.conversationId}
            conversationId={props.conversationId}
            layout="icon"
          />
          {props.sentryConversationUrl ? (
            <IconButtonTooltip label="Open in Sentry" placement="below">
              <a
                aria-label="Open in Sentry"
                className="grid size-9 place-items-center rounded-md text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-strong hover:text-dashboard-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-dashboard-focus"
                href={props.sentryConversationUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLink aria-hidden="true" size={15} />
              </a>
            </IconButtonTooltip>
          ) : null}
        </>
      }
      onClose={props.onClose}
    >
      <SegmentedTabs
        scroll
        items={tabs}
        label="Conversation details"
        onChange={setTab}
        value={tab}
      >
        {tab === "memories" ? (
          <ConversationMemories conversationId={props.conversationId} />
        ) : tab === "agents" ? (
          <ConversationChildAgents
            conversationId={props.conversationId}
            onOpenAgent={(target) => {
              // The panel stays beside the drawer. A modal sheet cannot.
              if (!panel) props.onClose();
              props.onOpenSubagent(target);
            }}
          />
        ) : props.brief != null || sections.length > 0 ? (
          <div className="grid min-w-0 gap-3">
            {props.brief != null ? (
              <div className="min-w-0 break-words px-1 pb-1 font-sans text-sm leading-relaxed text-dashboard-text-muted">
                {props.brief}
              </div>
            ) : null}
            {sections.map((section) => (
              <DetailsSection key={section.key} title={section.title}>
                {section.content}
              </DetailsSection>
            ))}
          </div>
        ) : (
          <p className="m-0 font-sans text-sm leading-relaxed text-dashboard-text-muted">
            No additional conversation details.
          </p>
        )}
      </SegmentedTabs>
    </ConversationDetailsFrame>
  );
}

/** Group one kind of conversation detail in a compact card. */
function DetailsSection(props: { children: ReactNode; title?: string }) {
  return (
    <section className="grid min-w-0 gap-2.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel p-3">
      {props.title ? (
        <h3 className="m-0 font-sans text-xs font-medium text-dashboard-text-muted">
          {props.title}
        </h3>
      ) : null}
      <div className="min-w-0 break-words font-sans text-xs leading-relaxed text-dashboard-text-muted">
        {props.children}
      </div>
    </section>
  );
}
