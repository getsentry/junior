import { Brain, Braces, ChevronRight, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { TranscriptViewTurnContext } from "../types";
import { formatMessageTimestamp, formatTime } from "../format";
import { memoryRecallContent, type MemoryRecallContent } from "./turnContext";
import { cn, dashboardInteractiveTextClass } from "../styles";
import { HighlightText } from "./transcriptSearch";

/** Show structured context attached to one transcript user message. */
export function TranscriptTurnContextView(props: {
  contexts: TranscriptViewTurnContext[];
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <div className="group/context relative flex justify-end">
        <button
          aria-controls={panelId}
          aria-expanded={open}
          aria-label="View turn context"
          className={cn(
            "grid size-7 cursor-pointer place-items-center rounded-md border border-transparent bg-transparent transition-colors hover:border-dashboard-border-strong hover:bg-dashboard-fill-mid focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-200/60",
            dashboardInteractiveTextClass,
            open && "border-dashboard-border-strong bg-dashboard-fill-mid text-cyan-100/80",
          )}
          onClick={() => setOpen(true)}
          ref={triggerRef}
          title="View turn context"
          type="button"
        >
          <Braces aria-hidden="true" size={15} strokeWidth={1.8} />
        </button>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0 bottom-[calc(100%+0.35rem)] z-10 whitespace-nowrap rounded border border-dashboard-border-strong bg-dashboard-tooltip px-2 py-1 text-xs font-medium text-dashboard-text-muted opacity-0 shadow-lg transition-opacity group-hover/context:opacity-100 group-focus-within/context:opacity-100"
        >
          View turn context
        </span>
      </div>

      {open ? (
        <TurnContextPanel
          contexts={props.contexts}
          id={panelId}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

function TurnContextPanel(props: {
  contexts: TranscriptViewTurnContext[];
  id: string;
  onClose(): void;
}) {
  return (
    <div className="fixed inset-0 z-50">
      <button
        aria-label="Close turn context"
        className="absolute inset-0 cursor-default border-0 bg-dashboard-overlay-heavy backdrop-blur-[1px]"
        onClick={props.onClose}
        type="button"
      />
      <section
        aria-label="Turn context"
        aria-modal="true"
        className="absolute inset-y-0 right-0 flex w-full max-w-[34rem] flex-col border-l border-dashboard-border-emphasis bg-dashboard-surface-raised shadow-2xl shadow-dashboard-shadow-heavy"
        id={props.id}
        role="dialog"
      >
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-dashboard-border-strong px-5 pt-[env(safe-area-inset-top)]">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-cyan-200/10 text-cyan-100/80">
              <Braces aria-hidden="true" size={17} strokeWidth={1.8} />
            </span>
            <div className="min-w-0">
              <h2 className="m-0 text-sm font-semibold text-dashboard-text">
                Turn context
              </h2>
              <p className="m-0 mt-0.5 text-xs text-dashboard-text-muted">
                Structured context supplied with this message
              </p>
            </div>
          </div>
          <button
            aria-label="Close turn context"
            autoFocus
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-stronger hover:text-dashboard-text"
            onClick={props.onClose}
            title="Close turn context"
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {props.contexts.map((context, index) => (
            <TurnContext
              context={context}
              key={`${context.pluginName}:${context.kind}:${context.version}:${index}`}
            />
          ))}
        </div>
      </section>
    </div>
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
          <summary className="flex cursor-pointer list-none items-start gap-2.5 px-3 py-3 transition-colors hover:bg-dashboard-fill-mid [&::-webkit-details-marker]:hidden">
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
          </summary>

          <div className="border-t border-dashboard-border bg-dashboard-fill-soft px-4 py-4">
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
      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-dashboard-fill-mid p-3 text-xs leading-relaxed text-dashboard-text-muted">
        <HighlightText text={JSON.stringify(props.context.content, null, 2)} />
      </pre>
      <p className="m-0 mt-3 text-xs text-dashboard-text-muted">
        Loaded {formatMessageTimestamp(Date.parse(props.context.loadedAt))}
      </p>
    </div>
  );
}
