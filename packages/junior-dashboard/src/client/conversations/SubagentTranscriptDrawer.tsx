import { useState } from "react";
import { Bot, CircleAlert, ExternalLink } from "lucide-react";
import { Link } from "react-router";

import { useConversationData } from "./queries";
import { conversationPath } from "./conversationRoutes";
import {
  conversationDetailTitle,
  formatMessageTimestamp,
  formatRelativeMessageTimestamp,
} from "../format";
import { buildConversationMarkdown } from "../markdownExport";
import { Drawer } from "../components/Drawer";
import { EmptyTelemetry } from "../components/EmptyTelemetry";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { SearchInput } from "../components/SearchInput";
import { StatusChip } from "../components/StatusChip";
import { subagentStatusTone } from "./ConversationChildAgents";
import { CopyButton } from "../components/CopyButton";
import {
  TranscriptSearchToggle,
  TranscriptViewToggle,
} from "./ConversationHeaderActions";
import { Transcript } from "./TranscriptView";
import { TranscriptLoading } from "./TranscriptLoading";
import type { TranscriptViewMode } from "./transcriptRenderModel";

/** One child Conversation to show, with what its parent already knows. */
export interface SubagentTranscriptTarget {
  /** Agent name, such as "planner". Shown beside the status. */
  agentName?: string;
  conversationId: string;
  /** Task title or agent name, shown before the child loads. */
  label?: string;
  /** Child status from the parent, which knows how the child ended. */
  status?: string;
}

/** Show a child conversation through the ordinary authorized detail API. */
export function SubagentTranscriptDrawer(props: {
  onClose: () => void;
  target: SubagentTranscriptTarget | undefined;
}) {
  if (!props.target) return null;
  // Remount per child so search/view state does not leak across drawer reuse.
  return (
    <SubagentTranscriptDrawerContent
      key={props.target.conversationId}
      onClose={props.onClose}
      target={props.target}
    />
  );
}

function SubagentTranscriptDrawerContent(props: {
  onClose: () => void;
  target: SubagentTranscriptTarget;
}) {
  const query = useConversationData(props.target.conversationId);
  const [view, setView] = useState<TranscriptViewMode>("rich");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const detail = query.data;
  const label =
    props.target.label ?? conversationDetailTitle(detail) ?? "Subagent";
  const status = statusLabel(props.target.status, detail?.status);
  const agentName =
    props.target.agentName && props.target.agentName !== label
      ? props.target.agentName
      : undefined;
  const startedAt = detail ? Date.parse(detail.startedAt) : undefined;
  const searchOpenVisible =
    view === "rich" && (searchOpen || search.length > 0);

  const titleId = "subagent-transcript-drawer-title";

  return (
    <Drawer
      actions={
        <>
          {view === "rich" ? (
            <TranscriptSearchToggle
              onClick={() => {
                if (searchOpenVisible) {
                  setSearchOpen(false);
                  if (search.length > 0) setSearch("");
                  return;
                }
                setSearchOpen(true);
              }}
              open={searchOpenVisible}
            />
          ) : null}
          <TranscriptViewToggle onChange={setView} value={view} />
          <CopyButton
            label="Copy as Markdown"
            copyingLabel="Preparing Markdown"
            key={props.target.conversationId}
            getText={
              detail
                ? async () =>
                    buildConversationMarkdown(
                      await query.loadCompleteTranscript(),
                    )
                : undefined
            }
          />
        </>
      }
      closeLabel="Close subagent transcript"
      header={
        <>
          <div className="flex min-w-0 items-center gap-2">
            <Bot
              aria-hidden="true"
              className="shrink-0 text-cyan-300"
              size={16}
              strokeWidth={2}
            />
            <h2
              className="m-0 min-w-0 break-words font-display text-lg font-medium leading-tight tracking-tight text-dashboard-text"
              id={titleId}
            >
              {label}
            </h2>
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-dashboard-text-muted">
            {agentName ? (
              <span className="font-medium text-dashboard-text">
                {agentName}
              </span>
            ) : null}
            {status ? (
              <StatusChip size="compact" tone={subagentStatusTone(status)}>
                {status}
              </StatusChip>
            ) : null}
            {detail && startedAt !== undefined ? (
              <time
                className="tabular-nums"
                dateTime={detail.startedAt}
                title={formatMessageTimestamp(startedAt, true)}
              >
                Started {formatRelativeMessageTimestamp(startedAt)}
              </time>
            ) : null}
            <Link
              className="inline-flex w-fit items-center gap-1 font-medium text-dashboard-accent-text no-underline hover:underline"
              onClick={props.onClose}
              to={conversationPath(props.target.conversationId)}
            >
              Open conversation
              <ExternalLink aria-hidden="true" size={12} strokeWidth={2} />
            </Link>
          </div>
          <code className="mt-1 block min-w-0 break-all font-mono text-xs text-dashboard-text-faint">
            {props.target.conversationId}
          </code>
          {searchOpenVisible ? (
            <div className="mt-3 min-w-0">
              <SearchInput
                className="min-w-0"
                label="Search transcript"
                onChange={setSearch}
                placeholder="Search transcript…"
                size="compact"
                value={search}
              />
            </div>
          ) : null}
        </>
      }
      onClose={props.onClose}
      openKey={props.target.conversationId}
      titleId={titleId}
      width="wide"
    >
      {query.isPending ? (
        <TranscriptLoading />
      ) : query.error && !detail ? (
        <Alert
          className="gap-1 px-4 py-3 has-[>svg]:gap-x-3"
          variant="destructive"
        >
          <CircleAlert aria-hidden="true" />
          <AlertTitle className="font-display text-base font-semibold leading-tight">
            Conversation failed to load.
          </AlertTitle>
          <AlertDescription className="leading-relaxed">
            Junior could not get this child conversation. Use Open conversation
            to view it on its own page.
          </AlertDescription>
        </Alert>
      ) : detail ? (
        <Transcript
          hasPreviousPage={query.hasPreviousPage}
          historyError={query.historyError}
          historyVersion={query.historyVersion}
          loadingPreviousPage={query.isLoadingPreviousPage}
          onLoadPreviousPage={query.loadPreviousPage}
          search={search}
          onSearchChange={setSearch}
          transcript={detail}
          view={view}
        />
      ) : (
        <EmptyTelemetry>Conversation unavailable.</EmptyTelemetry>
      )}
    </Drawer>
  );
}

function statusLabel(
  status: string | undefined,
  detailStatus: string | undefined,
): string | undefined {
  if (status && status !== "running" && status !== "completed") {
    return status;
  }
  return detailStatus ?? status;
}
