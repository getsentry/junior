import { Fragment, type ReactNode } from "react";

import type {
  RenderedThinkingEntry,
  RenderedToolEntry,
  RenderedToolRunEntry,
} from "./transcriptRenderModel";
import { useTranscriptSearch } from "./transcriptSearch";

const TOOL_RUN_REVEAL_THRESHOLD = 4;

/** Render a consecutive tool-and-thinking run with a one-way reveal for dense middle calls. */
export function TranscriptToolRun(props: {
  autoCollapse: boolean;
  entries: RenderedToolRunEntry[];
  keyPrefix: string;
  renderThinking: (entry: RenderedThinkingEntry, index: number) => ReactNode;
  renderTool: (entry: RenderedToolEntry, index: number) => ReactNode;
  startIndex: number;
}) {
  const { active: searchActive } = useTranscriptSearch();

  if (
    !props.autoCollapse ||
    props.entries.length < TOOL_RUN_REVEAL_THRESHOLD ||
    searchActive
  ) {
    return (
      <>
        {renderRunEntries(
          props.entries,
          props.startIndex,
          props.keyPrefix,
          props.renderTool,
          props.renderThinking,
        )}
      </>
    );
  }

  return (
    <details className="min-w-0">
      <ToolRunReveal entries={props.entries} />
      <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        {renderRunEntries(
          props.entries,
          props.startIndex,
          props.keyPrefix,
          props.renderTool,
          props.renderThinking,
        )}
      </div>
    </details>
  );
}

function renderRunEntries(
  entries: RenderedToolRunEntry[],
  startIndex: number,
  keyPrefix: string,
  renderTool: (entry: RenderedToolEntry, index: number) => ReactNode,
  renderThinking: (entry: RenderedThinkingEntry, index: number) => ReactNode,
): ReactNode[] {
  return entries.map((entry, offset) => {
    const index = startIndex + offset;
    return (
      <Fragment key={`${keyPrefix}:${entry.kind}:${index}`}>
        {entry.kind === "thinking"
          ? renderThinking(entry, index)
          : renderTool(entry, index)}
      </Fragment>
    );
  });
}

function formatRunRevealLabel(entries: RenderedToolRunEntry[]): string {
  const toolCount = entries.filter((e) => e.kind === "tool").length;
  const thinkingCount = entries.filter((e) => e.kind === "thinking").length;
  const parts: string[] = [];
  if (toolCount > 0) {
    parts.push(`${toolCount} tool ${toolCount === 1 ? "call" : "calls"}`);
  }
  if (thinkingCount > 0) {
    parts.push(
      `${thinkingCount} thinking ${thinkingCount === 1 ? "entry" : "entries"}`,
    );
  }
  return `show ${parts.join(" and ")}`;
}

function ToolRunReveal(props: { entries: RenderedToolRunEntry[] }) {
  return (
    <summary className="group flex w-full cursor-pointer list-none items-center gap-2 py-1.5 text-left font-mono text-[0.78rem] leading-tight text-white/40 transition-colors hover:text-white/80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden">
      <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
      <span className="shrink-0">{formatRunRevealLabel(props.entries)}</span>
      <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
    </summary>
  );
}
