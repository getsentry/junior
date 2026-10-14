import { useState } from "react";
import { Bot, ExternalLink } from "lucide-react";
import { Link } from "react-router";

import { useConversationData } from "./queries";
import { conversationPath } from "./conversationRoutes";
import { conversationDetailTitle, formatMessageTimestamp } from "../format";
import { buildConversationMarkdown } from "../markdownExport";
import { Drawer } from "../components/Drawer";
import { SearchInput } from "../components/SearchInput";
import { StatusChip } from "../components/StatusChip";
import { subagentStatusTone } from "./ConversationChildAgents";
import { CopyMarkdownButton } from "./CopyMarkdownButton";
import {
  TranscriptSearchToggle,
  TranscriptViewToggle,
} from "./ConversationHeaderActions";
import { Transcript } from "./TranscriptView";
import { TranscriptLoading } from "./TranscriptLoading";
import type { TranscriptViewMode } from "./transcriptRenderModel";
import { transcriptEmptyClass } from "./transcriptStyles";

/** One child Conversation to show, with what its parent already knows. */
export interface SubagentTranscriptTarget {
  conversationId: string;
  /** Agent name or task title, shown before the child loads. */
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
  const searchOpenVisible = searchOpen || search.length > 0;

  const titleId = "subagent-transcript-drawer-title";

  return (
    <Drawer
      actions={
        <>
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
          <TranscriptViewToggle onChange={setView} value={view} />
          <CopyMarkdownButton
            key={props.target.conversationId}
            getMarkdown={
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
      dismissLabel="Dismiss subagent transcript"
      header={
        <>
          <div className="flex min-w-0 items-center gap-2">
            <Bot
              aria-hidden="true"
              className="shrink-0 text-cyan-300"
              size={16}
              strokeWidth={2.25}
            />
            <h2
              className="m-0 min-w-0 break-words text-lg font-bold leading-tight tracking-normal text-dashboard-text"
              id={titleId}
            >
              {label}
            </h2>
          </div>
          <div className="mt-2 grid min-w-0 gap-1.5 text-xs leading-snug">
            <code className="min-w-0 break-all font-mono text-xs text-dashboard-text">
              {props.target.conversationId}
            </code>
            <Link
              className="inline-flex w-fit items-center gap-1 font-semibold text-dashboard-text no-underline hover:underline"
              onClick={props.onClose}
              to={conversationPath(props.target.conversationId)}
            >
              Open conversation
              <ExternalLink aria-hidden="true" size={12} strokeWidth={2.25} />
            </Link>
          </div>
          {status || detail ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-snug text-dashboard-text-muted">
              {status ? (
                <StatusChip size="compact" tone={subagentStatusTone(status)}>
                  {status}
                </StatusChip>
              ) : null}
              {detail ? (
                <time className="font-mono" dateTime={detail.startedAt}>
                  {formatMessageTimestamp(Date.parse(detail.startedAt))}
                </time>
              ) : null}
            </div>
          ) : null}
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
        <DrawerEmptyState tone="error">
          Conversation failed to load.
        </DrawerEmptyState>
      ) : detail ? (
        <Transcript
          hasPreviousPage={query.hasPreviousPage}
          historyError={query.historyError}
          historyVersion={query.historyVersion}
          loadingPreviousPage={query.isLoadingPreviousPage}
          onLoadPreviousPage={query.loadPreviousPage}
          search={search}
          transcript={detail}
          view={view}
        />
      ) : (
        <DrawerEmptyState>Conversation unavailable.</DrawerEmptyState>
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

function DrawerEmptyState(props: {
  children: string;
  tone?: "default" | "error";
}) {
  const isError = props.tone === "error";
  return (
    <div
      className={transcriptEmptyClass(isError ? "error" : "default")}
      data-tone={props.tone ?? "default"}
      role={isError ? "alert" : undefined}
    >
      {props.children}
    </div>
  );
}
