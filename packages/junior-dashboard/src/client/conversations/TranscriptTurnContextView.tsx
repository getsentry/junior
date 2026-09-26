import { Brain, Braces, ChevronRight, Layers } from "lucide-react";
import { useId, useState } from "react";
import { createPortal } from "react-dom";

import { Drawer } from "../components/Drawer";
import type { TranscriptViewTurnContext } from "../types";
import { formatMessageTimestamp, formatTime } from "../format";
import { memoryRecallContent, type MemoryRecallContent } from "./turnContext";
import { cn } from "../styles";
import { HighlightText } from "./transcriptSearch";
import { TranscriptSummary } from "./TranscriptSummary";

/** Show structured context attached to one transcript user message. */
export function TranscriptTurnContextView(props: {
  contexts: TranscriptViewTurnContext[];
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="View turn context"
        className={cn(
          "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
          open && "bg-dashboard-fill-hover text-dashboard-text",
        )}
        onClick={() => setOpen(true)}
        title="View context"
        type="button"
      >
        <Layers aria-hidden="true" size={14} strokeWidth={1.8} />
      </button>

      {open
        ? createPortal(
            <Drawer
              closeLabel="Close turn context"
              dismissLabel="Dismiss turn context"
              header={
                <>
                  <h2
                    className="m-0 text-sm font-semibold text-dashboard-text"
                    id={titleId}
                  >
                    Turn context
                  </h2>
                  <p className="m-0 mt-1 text-xs text-dashboard-text-muted">
                    Context supplied with this message
                  </p>
                </>
              }
              onClose={() => setOpen(false)}
              openKey={titleId}
              titleId={titleId}
            >
              {props.contexts.map((context, index) => (
                <TurnContext
                  context={context}
                  key={`${context.pluginName}:${context.kind}:${context.version}:${index}`}
                />
              ))}
            </Drawer>,
            document.body,
          )
        : null}
    </>
  );
}

function TurnContext(props: { context: TranscriptViewTurnContext }) {
  const memory = memoryRecallContent(props.context);

  return (
    <section className="border-b border-dashboard-border-strong py-5 last:border-b-0">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {memory ? (
            <Brain
              aria-hidden="true"
              className="shrink-0 text-cyan-100/60"
              size={15}
            />
          ) : (
            <Braces
              aria-hidden="true"
              className="shrink-0 text-cyan-100/60"
              size={15}
            />
          )}
          <h3 className="m-0 truncate text-sm font-semibold text-dashboard-text">
            {memory ? "Recalled memories" : props.context.pluginName}
          </h3>
        </div>
        <span className="shrink-0 text-xs text-dashboard-text-muted">
          {props.context.kind} · v{props.context.version}
        </span>
      </div>

      {memory ? (
        <MemoryRecall
          loadedAt={props.context.loadedAt}
          memories={memory.memories}
        />
      ) : (
        <GenericContext context={props.context} />
      )}
    </section>
  );
}

function MemoryRecall(props: {
  loadedAt: string;
  memories: MemoryRecallContent["memories"];
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-dashboard-border-strong">
      {props.memories.map((memory, index) => (
        <details
          className="group/memory border-t border-dashboard-border-strong first:border-t-0"
          key={memory.id}
        >
          <TranscriptSummary className="flex items-start gap-2.5">
            <ChevronRight
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-dashboard-text-muted transition-transform group-open/memory:rotate-90"
              size={15}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium text-dashboard-text-muted">
                  Memory {index + 1}
                </span>
                <span className="shrink-0 text-xs text-dashboard-text-muted">
                  {memory.kind} · {memory.scope}
                </span>
              </span>
              <span className="mt-1 block truncate text-sm text-dashboard-text-muted">
                <HighlightText text={memory.content} />
              </span>
            </span>
          </TranscriptSummary>

          <div className="border-t border-dashboard-border bg-dashboard-fill-faint px-4 py-4">
            <div className="whitespace-pre-wrap text-sm leading-6 text-dashboard-text">
              <HighlightText text={memory.content} />
            </div>

            <dl className="mt-4 grid gap-2 text-xs">
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
                <dt className="text-dashboard-text-muted">Memory ID</dt>
                <dd className="m-0 break-all font-mono text-dashboard-text-muted">
                  <HighlightText text={memory.id} />
                </dd>
              </div>
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
                <dt className="text-dashboard-text-muted">Observed</dt>
                <dd className="m-0 text-dashboard-text-muted">
                  {formatTime(new Date(memory.observedAtMs).toISOString())}
                </dd>
              </div>
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
                <dt className="text-dashboard-text-muted">Scope</dt>
                <dd className="m-0 text-dashboard-text-muted">
                  {memory.scope}
                </dd>
              </div>
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
                <dt className="text-dashboard-text-muted">Kind</dt>
                <dd className="m-0 text-dashboard-text-muted">{memory.kind}</dd>
              </div>
            </dl>
          </div>
        </details>
      ))}
      <p className="m-0 border-t border-dashboard-border-strong px-3 py-2 text-xs text-dashboard-text-muted">
        {props.memories.length}{" "}
        {props.memories.length === 1 ? "memory" : "memories"} · Loaded{" "}
        {formatMessageTimestamp(Date.parse(props.loadedAt))}
      </p>
    </div>
  );
}

function GenericContext(props: { context: TranscriptViewTurnContext }) {
  return (
    <div>
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-dashboard-fill-soft p-3 text-xs leading-relaxed text-dashboard-text-muted">
        <HighlightText text={JSON.stringify(props.context.content, null, 2)} />
      </pre>
      <p className="m-0 mt-3 text-xs text-dashboard-text-muted">
        Loaded {formatMessageTimestamp(Date.parse(props.context.loadedAt))}
      </p>
    </div>
  );
}
