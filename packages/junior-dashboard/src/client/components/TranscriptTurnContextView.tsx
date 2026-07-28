import { Brain } from "lucide-react";

import type { TranscriptViewTurnContext } from "../types";
import { formatMessageTimestamp } from "../format";
import {
  memoryRecallContent,
  type MemoryRecallContent,
} from "../conversations/turnContext";
import { HighlightText } from "./transcriptSearch";

/** Render structured context attached to one transcript user message. */
export function TranscriptTurnContextView(props: {
  contexts: TranscriptViewTurnContext[];
}) {
  return (
    <div className="grid gap-2">
      {props.contexts.map((context, index) => (
        <TurnContext
          context={context}
          key={`${context.pluginName}:${context.kind}:${context.version}:${index}`}
        />
      ))}
    </div>
  );
}

function TurnContext(props: { context: TranscriptViewTurnContext }) {
  const memory = memoryRecallContent(props.context);
  const count = memory?.memories.length;

  return (
    <details className="rounded-lg border border-cyan-300/15 bg-cyan-300/[0.035] px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[0.78rem] font-medium text-cyan-100/75 [&::-webkit-details-marker]:hidden">
        <Brain aria-hidden="true" className="size-3.5" />
        <span>
          {count === undefined
            ? `${props.context.pluginName} context`
            : `${count} recalled ${count === 1 ? "memory" : "memories"}`}
        </span>
      </summary>
      <div className="mt-3">
        {memory ? (
          <MemoryRecall
            loadedAt={props.context.loadedAt}
            memories={memory.memories}
          />
        ) : (
          <GenericContext context={props.context} />
        )}
      </div>
    </details>
  );
}

function MemoryRecall(props: {
  loadedAt: string;
  memories: MemoryRecallContent["memories"];
}) {
  return (
    <div className="grid gap-3">
      <div className="text-[0.72rem] text-white/35">
        Loaded {formatMessageTimestamp(Date.parse(props.loadedAt))}
      </div>
      {props.memories.map((memory) => (
        <div
          className="grid gap-2 border-t border-white/8 pt-3 first:border-t-0 first:pt-0"
          key={memory.id}
        >
          <div className="whitespace-pre-wrap text-[0.82rem] leading-relaxed text-white/70">
            <HighlightText text={memory.content} />
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.7rem]">
            <dt className="text-white/30">ID</dt>
            <dd className="truncate font-mono text-white/50">{memory.id}</dd>
            <dt className="text-white/30">Observed</dt>
            <dd className="text-white/50">
              {formatMessageTimestamp(memory.observedAtMs)}
            </dd>
            <dt className="text-white/30">Scope</dt>
            <dd className="text-white/50">{memory.scope}</dd>
            <dt className="text-white/30">Kind</dt>
            <dd className="text-white/50">{memory.kind}</dd>
          </dl>
        </div>
      ))}
    </div>
  );
}

function GenericContext(props: { context: TranscriptViewTurnContext }) {
  return (
    <div className="grid gap-2">
      <div className="text-[0.72rem] text-white/35">
        {props.context.kind} v{props.context.version} · Loaded{" "}
        {formatMessageTimestamp(Date.parse(props.context.loadedAt))}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[0.72rem] leading-relaxed text-white/55">
        <HighlightText text={JSON.stringify(props.context.content, null, 2)} />
      </pre>
    </div>
  );
}
