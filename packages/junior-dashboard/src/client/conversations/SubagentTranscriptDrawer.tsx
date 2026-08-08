import { useEffect } from "react";
import { Bot, ExternalLink, X } from "lucide-react";
import { Link } from "react-router";

import { useConversationData } from "./queries";
import { conversationPath, formatMessageTimestamp } from "../format";
import { buildConversationMarkdown } from "../markdownExport";
import type { TranscriptViewSubagentPart } from "../types";
import { Button } from "../components/Button";
import { CopyMarkdownButton } from "./CopyMarkdownButton";
import { Transcript } from "./TranscriptView";
import { TranscriptLoading } from "./TranscriptLoading";
import { transcriptEmptyClass } from "./transcriptStyles";

export interface SubagentTranscriptTarget {
  conversationId: string;
  part: TranscriptViewSubagentPart;
}

/** Show a child conversation through the ordinary authorized detail API. */
export function SubagentTranscriptDrawer(props: {
  onClose: () => void;
  target: SubagentTranscriptTarget | undefined;
}) {
  const { onClose, target } = props;
  const query = useConversationData(target?.conversationId);

  useEffect(() => {
    if (!target) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, target]);

  if (!props.target) return null;

  const detail = query.data;
  const label = detail?.displayTitle || props.target.part.subagentKind;
  const meta = [
    statusLabel(props.target.part, detail?.status),
    detail ? formatMessageTimestamp(Date.parse(detail.startedAt)) : undefined,
  ].filter(isString);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        aria-label="Close subagent transcript"
        className="absolute inset-0 cursor-default bg-black/55"
        onClick={props.onClose}
        type="button"
      />
      <aside className="absolute right-0 top-0 grid h-full w-full grid-rows-[auto_minmax(0,1fr)] bg-[#070707] shadow-[-20px_0_60px_rgba(0,0,0,0.45)] md:w-[min(760px,94vw)] md:border-l md:border-white/12">
        <header className="relative border-b border-white/10 bg-dashboard-surface-raised px-4 py-3 md:px-5">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 pr-24">
              <Bot
                aria-hidden="true"
                className="shrink-0 text-cyan-300"
                size={16}
                strokeWidth={2.25}
              />
              <h2 className="m-0 min-w-0 break-words text-lg font-bold leading-tight tracking-normal text-dashboard-text">
                {label}
              </h2>
            </div>
            <div className="mt-2 grid min-w-0 gap-1.5 text-xs leading-snug">
              <code className="min-w-0 break-all font-mono text-xs text-dashboard-text">
                {props.target.conversationId}
              </code>
              <Link
                className="inline-flex w-fit items-center gap-1 font-semibold text-dashboard-text no-underline hover:underline"
                to={conversationPath(props.target.conversationId)}
                onClick={props.onClose}
              >
                Open conversation
                <ExternalLink aria-hidden="true" size={12} strokeWidth={2.25} />
              </Link>
            </div>
            <div className="mt-1 break-words font-mono text-xs leading-snug text-dashboard-text-muted">
              {meta.join(" · ")}
            </div>
            <div className="absolute right-4 top-3 flex items-center gap-1.5 md:right-5">
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
              <Button
                aria-label="Close subagent transcript"
                onClick={props.onClose}
                size="icon"
                title="Close"
              >
                <X aria-hidden="true" size={15} strokeWidth={2.25} />
              </Button>
            </div>
          </div>
        </header>
        <div className="min-h-0 overflow-auto px-4 py-4 md:px-5">
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
              transcript={detail}
            />
          ) : (
            <DrawerEmptyState>Conversation unavailable.</DrawerEmptyState>
          )}
        </div>
      </aside>
    </div>
  );
}

function statusLabel(
  part: TranscriptViewSubagentPart,
  detailStatus?: string,
): string {
  if (part.status === "error" || part.status === "aborted") {
    return part.status;
  }
  return detailStatus ?? part.status;
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

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
