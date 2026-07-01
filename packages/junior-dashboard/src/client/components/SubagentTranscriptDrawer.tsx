import { useEffect } from "react";
import { Bot, ExternalLink, X } from "lucide-react";

import { useConversationSubagentTranscriptData } from "../api";
import { formatMessageTimestamp, formatMs } from "../format";
import { cn } from "../styles";
import type {
  ConversationSubagentTranscript,
  ConversationTurn,
  TranscriptViewSubagentPart,
} from "../types";
import { Button } from "./Button";
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
      <aside className="absolute right-0 top-0 grid h-full w-[min(760px,94vw)] grid-rows-[auto_minmax(0,1fr)] border-l border-white/12 bg-[#070707] shadow-[-20px_0_60px_rgba(0,0,0,0.45)]">
        <header className="border-b border-white/10 bg-[#0b0b0b] px-4 py-3 md:px-5">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
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
              {meta.length > 0 ? (
                <div className="mt-1 break-words font-mono text-[0.78rem] leading-snug text-[#888]">
                  {meta.join(" · ")}
                </div>
              ) : null}
            </div>
            <Button
              aria-label="Close subagent transcript"
              onClick={props.onClose}
              size="icon"
              title="Close"
            >
              <X aria-hidden="true" size={15} strokeWidth={2.25} />
            </Button>
          </div>
        </header>
        <div className="min-h-0 overflow-auto px-4 py-4 md:px-5">
          {query.isPending ? (
            <TranscriptLoading />
          ) : query.error ? (
            <DrawerEmptyState tone="error">
              Transcript failed to load.
            </DrawerEmptyState>
          ) : report?.transcriptAvailable ? (
            <Transcript turns={[subagentTurn(props.target, report)]} />
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
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.78rem] leading-snug">
      {props.report.subagentConversationId ? (
        <span className="inline-flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-[#777]">Conversation ID</span>
          <code className="min-w-0 break-all font-mono text-[#d6d6d6]">
            {props.report.subagentConversationId}
          </code>
        </span>
      ) : null}
      {props.report.subagentSentryConversationUrl ? (
        <a
          className="inline-flex shrink-0 items-center gap-1 font-semibold text-white no-underline hover:underline"
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
    ...(target.part.outcome ? { outcome: target.part.outcome } : {}),
    ...(target.part.parentToolCallId
      ? { parentToolCallId: target.part.parentToolCallId }
      : {}),
  };
}

function subagentTurn(
  target: SubagentTranscriptTarget,
  report: ConversationSubagentTranscript,
): ConversationTurn {
  const status =
    report.status === "running"
      ? "active"
      : report.status === "error" || report.status === "aborted"
        ? "failed"
        : "completed";

  return {
    conversationId: target.conversationId,
    assistantLabel: report.subagentKind,
    cumulativeDurationMs: subagentDurationMs(report) ?? 0,
    displayTitle: report.subagentKind,
    id: report.id,
    lastProgressAt: report.endedAt ?? report.createdAt,
    lastSeenAt: report.endedAt ?? report.createdAt,
    startedAt: report.createdAt,
    status,
    surface: "internal",
    transcript: report.transcript,
    transcriptAvailable: report.transcriptAvailable,
    ...(report.endedAt ? { completedAt: report.endedAt } : {}),
    ...(report.transcriptMessageCount !== undefined
      ? { transcriptMessageCount: report.transcriptMessageCount }
      : {}),
    ...(report.transcriptRedacted
      ? { transcriptRedacted: report.transcriptRedacted }
      : {}),
    ...(report.transcriptRedactionReason
      ? { transcriptRedactionReason: report.transcriptRedactionReason }
      : {}),
  };
}

function subagentDurationMs(
  report: Pick<ConversationSubagentTranscript, "createdAt" | "endedAt">,
): number | undefined {
  if (!report.endedAt) return undefined;
  const startedAt = Date.parse(report.createdAt);
  const endedAt = Date.parse(report.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) {
    return undefined;
  }
  return endedAt >= startedAt ? endedAt - startedAt : undefined;
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
