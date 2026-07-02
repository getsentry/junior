import { Fragment, type ReactNode } from "react";

import type {
  RenderedThinkingEntry,
  RenderedToolEntry,
  RenderedToolRunEntry,
} from "./transcriptRenderModel";
import { useTranscriptSearch } from "./transcriptSearch";

const TOOL_RUN_REVEAL_THRESHOLD = 4;

/** Render a consecutive tool-and-thinking run with a one-way reveal for dense middle calls.
 *
 * When the run is long enough, the first and last entries are always visible as
 * bookends so the reader has context on what opened and closed the block. The
 * middle entries are collapsed behind a reveal separator.
 */
export function TranscriptToolRun(props: {
  entries: RenderedToolRunEntry[];
  keyPrefix: string;
  renderThinking: (entry: RenderedThinkingEntry, index: number) => ReactNode;
  renderTool: (entry: RenderedToolEntry, index: number) => ReactNode;
  startIndex: number;
}) {
  const { active: searchActive } = useTranscriptSearch();

  if (props.entries.length < TOOL_RUN_REVEAL_THRESHOLD || searchActive) {
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

  const first = props.entries[0]!;
  const last = props.entries[props.entries.length - 1]!;
  const middle = props.entries.slice(1, -1);

  return (
    <>
      {renderRunEntry(
        first,
        props.startIndex,
        props.keyPrefix,
        props.renderTool,
        props.renderThinking,
      )}
      <details className="min-w-0">
        <ToolRunReveal entries={props.entries} />
        <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {renderRunEntries(
            middle,
            props.startIndex + 1,
            props.keyPrefix,
            props.renderTool,
            props.renderThinking,
          )}
        </div>
      </details>
      {renderRunEntry(
        last,
        props.startIndex + props.entries.length - 1,
        props.keyPrefix,
        props.renderTool,
        props.renderThinking,
      )}
    </>
  );
}

function renderRunEntry(
  entry: RenderedToolRunEntry,
  index: number,
  keyPrefix: string,
  renderTool: (entry: RenderedToolEntry, index: number) => ReactNode,
  renderThinking: (entry: RenderedThinkingEntry, index: number) => ReactNode,
): ReactNode {
  return (
    <Fragment key={`${keyPrefix}:${entry.kind}:${index}`}>
      {entry.kind === "thinking"
        ? renderThinking(entry, index)
        : renderTool(entry, index)}
    </Fragment>
  );
}

function renderRunEntries(
  entries: RenderedToolRunEntry[],
  startIndex: number,
  keyPrefix: string,
  renderTool: (entry: RenderedToolEntry, index: number) => ReactNode,
  renderThinking: (entry: RenderedThinkingEntry, index: number) => ReactNode,
): ReactNode[] {
  return entries.map((entry, offset) =>
    renderRunEntry(
      entry,
      startIndex + offset,
      keyPrefix,
      renderTool,
      renderThinking,
    ),
  );
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
    <summary className="group flex w-full cursor-pointer list-none items-center gap-2 py-1.5 text-left font-mono text-[0.78rem] leading-tight text-[#888] transition-colors hover:text-[#d6d6d6] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#beaaff]/55 [&::-webkit-details-marker]:hidden">
      <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
      <span className="shrink-0">{formatRunRevealLabel(props.entries)}</span>
      <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
    </summary>
  );
}
