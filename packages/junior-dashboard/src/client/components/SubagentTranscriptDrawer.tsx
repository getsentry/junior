import { useEffect } from "react";
import { Bot, ExternalLink, X } from "lucide-react";

import { useConversationSubagentTranscriptData } from "../api";
import { formatMessageTimestamp, formatMs } from "../format";
import { buildSubagentMarkdown } from "../markdownExport";
import { cn } from "../styles";
import {
  subagentDurationMs,
  subagentTranscriptTurn,
} from "../subagentTranscript";
import type {
  ConversationSubagentTranscript,
  ConversationTurn,
  TranscriptViewSubagentPart,
} from "../types";
import { Button } from "./Button";
import { CopyMarkdownButton } from "./CopyMarkdownButton";
import { ExecutionSignature } from "./ExecutionSignature";
import { Transcript } from "./Transcript";
import { TranscriptLoading } from "./TranscriptLoading";
import { transcriptEmptyClass } from "./transcriptStyles";

export interface SubagentTranscriptTarget {
  conversationId: string;
  part: TranscriptViewSubagentPart;
  turn: ConversationTurn;
}

/** Show a lazily loaded child-agent transcript without leaving the parent run. */
export function SubagentTranscriptDrawer(props: {
  onClose: () => void;
  target: SubagentTranscriptTarget | undefined;
}) {
  const query = useConversationSubagentTranscriptData(
    props.target
      ? {
          conversationId: props.target.conversationId,
          runId: props.target.turn.id,
          subagentId: props.target.part.id,
        }
      : undefined,
  );

  useEffect(() => {
    if (!props.target) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose, props.target]);

  if (!props.target) return null;

  const report = query.data;
  const visible = report ?? subagentFallback(props.target);
  const label = visible.subagentKind;
  const duration = subagentDuration(visible);
  const transcriptTurn = report
    ? subagentTranscriptTurn(props.target.conversationId, report)
    : undefined;
  const meta = [
    statusLabel(visible),
    duration,
    formatMessageTimestamp(Date.parse(visible.createdAt)),
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
        <header className="relative border-b border-white/10 bg-[#0b0b0b] px-4 py-3 md:px-5">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 pr-24">
              <Bot
                aria-hidden="true"
                className="shrink-0 text-cyan-300"
                size={16}
                strokeWidth={2.25}
              />
              <h2 className="m-0 min-w-0 break-words text-lg font-bold leading-tight tracking-normal text-white">
                {label}
              </h2>
            </div>
            <DrawerConversationIdentity report={visible} />
            <ExecutionSignature
              className="mt-1 block"
              modelId={visible.modelId}
              reasoningLevel={visible.reasoningLevel}
            />
            {meta.length > 0 ? (
              <div className="mt-1 break-words font-mono text-[0.78rem] leading-snug text-[#888]">
                {meta.join(" · ")}
              </div>
            ) : null}
            <div className="absolute right-4 top-3 flex items-center gap-1.5 md:right-5">
              <CopyMarkdownButton
                key={`${props.target.part.id}:${report?.endedAt ?? "loading"}`}
                getMarkdown={
                  report?.transcriptAvailable && transcriptTurn
                    ? () => buildSubagentMarkdown(report, transcriptTurn)
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
          ) : query.error ? (
            <DrawerEmptyState tone="error">
              Transcript failed to load.
            </DrawerEmptyState>
          ) : report?.transcriptAvailable && transcriptTurn ? (
            <Transcript turns={[transcriptTurn]} />
          ) : (
            <DrawerEmptyState>
              {subagentUnavailableLabel(report)}
            </DrawerEmptyState>
          )}
        </div>
      </aside>
    </div>
  );
}

function DrawerConversationIdentity(props: {
  report: ConversationSubagentTranscript;
}) {
  if (
    !props.report.subagentConversationId &&
    !props.report.subagentSentryConversationUrl
  ) {
    return null;
  }

  return (
    <div className="mt-2 grid min-w-0 gap-1.5 text-[0.78rem] leading-snug">
      {props.report.subagentConversationId ? (
        <span className="grid min-w-0 grid-cols-1 items-baseline gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
          <span className="hidden shrink-0 text-[#777] sm:inline">
            Conversation ID
          </span>
          <code className="min-w-0 font-mono text-[0.72rem] text-[#d6d6d6] sm:text-[0.78rem]">
            {props.report.subagentConversationId
              .split(":")
              .map((segment, index, segments) => (
                <span key={`${index}-${segment}`}>
                  {segment}
                  {index < segments.length - 1 ? (
                    <>
                      :<wbr />
                    </>
                  ) : null}
                </span>
              ))}
          </code>
        </span>
      ) : null}
      {props.report.subagentSentryConversationUrl ? (
        <a
          className="inline-flex w-fit items-center gap-1 font-semibold text-white no-underline hover:underline"
          href={props.report.subagentSentryConversationUrl}
          rel="noreferrer"
          target="_blank"
        >
          View in Sentry
          <ExternalLink aria-hidden="true" size={12} strokeWidth={2.25} />
        </a>
      ) : null}
    </div>
  );
}

function subagentFallback(
  target: SubagentTranscriptTarget,
): ConversationSubagentTranscript {
  return {
    type: "subagent",
    createdAt: new Date(target.turn.startedAt).toISOString(),
    id: target.part.id,
    status: target.part.status,
    subagentKind: target.part.subagentKind,
    transcript: [],
    transcriptAvailable: false,
    ...(target.part.endedAt ? { endedAt: target.part.endedAt } : {}),
    ...(target.part.modelId ? { modelId: target.part.modelId } : {}),
    ...(target.part.outcome ? { outcome: target.part.outcome } : {}),
    ...(target.part.parentToolCallId
      ? { parentToolCallId: target.part.parentToolCallId }
      : {}),
    ...(target.part.reasoningLevel
      ? { reasoningLevel: target.part.reasoningLevel }
      : {}),
  };
}

function subagentDuration(
  report: Pick<ConversationSubagentTranscript, "createdAt" | "endedAt">,
): string | undefined {
  const durationMs = subagentDurationMs(report);
  return durationMs === undefined ? undefined : formatMs(durationMs);
}

function statusLabel(
  report: ConversationSubagentTranscript,
): string | undefined {
  if (report.outcome === "error") return "error";
  if (report.outcome === "aborted") return "aborted";
  if (report.status === "error" || report.status === "aborted") {
    return report.status;
  }
  return undefined;
}

function subagentUnavailableLabel(
  report: ConversationSubagentTranscript | undefined,
): string {
  if (report?.transcriptRedacted) {
    return "Transcript hidden because this conversation is not public.";
  }

  if (report?.unavailableReason === "missing_transcript_range") {
    return "This subagent was recorded before per-invocation transcripts were available.";
  }

  if (report?.unavailableReason === "missing_transcript_ref") {
    return "The referenced subagent transcript is no longer available.";
  }

  return "No subagent transcript is available.";
}

function DrawerEmptyState(props: {
  children: string;
  tone?: "error" | "muted";
}) {
  return (
    <div
      className={cn(
        transcriptEmptyClass(),
        props.tone === "error" && "border-rose-300/25 text-rose-100",
      )}
    >
      {props.children}
    </div>
  );
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
