import { Fragment, type ReactNode } from "react";

import type { RenderedToolEntry } from "./transcriptRenderModel";
import { useTranscriptSearch } from "./transcriptSearch";

const TOOL_RUN_REVEAL_THRESHOLD = 4;

/** Collapse dense consecutive tool rows while keeping search results open. */
export function TranscriptToolRun(props: {
  autoCollapse: boolean;
  entries: RenderedToolEntry[];
  renderTool: (entry: RenderedToolEntry) => ReactNode;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const rows = props.entries.map((entry) => (
    <Fragment key={entry.key}>{props.renderTool(entry)}</Fragment>
  ));

  if (
    !props.autoCollapse ||
    props.entries.length < TOOL_RUN_REVEAL_THRESHOLD ||
    searchActive
  ) {
    return <>{rows}</>;
  }

  return (
    <details className="group/tool-run min-w-0">
      <summary className="group flex w-full cursor-pointer list-none items-center gap-2 py-1.5 text-left font-mono text-[0.78rem] leading-tight text-white/40 transition-colors hover:text-white/80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300/55 [&::-webkit-details-marker]:hidden">
        <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
        <span className="shrink-0 group-open/tool-run:hidden">
          show {props.entries.length} tool calls
        </span>
        <span className="hidden shrink-0 group-open/tool-run:inline">
          hide {props.entries.length} tool calls
        </span>
        <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
      </summary>
      <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        {rows}
      </div>
    </details>
  );
}
