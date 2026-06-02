import { Fragment, useState, type ReactNode } from "react";

import type { RenderedToolEntry } from "./transcriptRenderModel";

const TOOL_RUN_REVEAL_THRESHOLD = 4;

/** Render a consecutive tool run with a one-way reveal for dense middle calls. */
export function TranscriptToolRun(props: {
  entries: RenderedToolEntry[];
  keyPrefix: string;
  renderTool: (entry: RenderedToolEntry, index: number) => ReactNode;
  startIndex: number;
}) {
  const [revealed, setRevealed] = useState(false);

  if (props.entries.length < TOOL_RUN_REVEAL_THRESHOLD || revealed) {
    return (
      <>
        {renderToolEntries(
          props.entries,
          props.startIndex,
          props.keyPrefix,
          props.renderTool,
        )}
      </>
    );
  }

  return (
    <ToolRunReveal
      hiddenCount={props.entries.length}
      onClick={() => setRevealed(true)}
    />
  );
}

function renderToolEntries(
  entries: RenderedToolEntry[],
  startIndex: number,
  keyPrefix: string,
  renderTool: (entry: RenderedToolEntry, index: number) => ReactNode,
): ReactNode[] {
  return entries.map((entry, offset) => {
    const index = startIndex + offset;
    return (
      <Fragment key={`${keyPrefix}:tool:${index}`}>
        {renderTool(entry, index)}
      </Fragment>
    );
  });
}

function ToolRunReveal(props: { hiddenCount: number; onClick: () => void }) {
  return (
    <button
      aria-expanded={false}
      className="group flex w-full cursor-pointer items-center gap-2 py-1.5 text-left font-mono text-[0.78rem] leading-tight text-[#888] transition-colors hover:text-[#d6d6d6] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[#beaaff]/55"
      onClick={props.onClick}
      type="button"
    >
      <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
      <span className="shrink-0">show {props.hiddenCount} tool calls</span>
      <span className="h-px min-w-4 flex-1 bg-white/10 transition-colors group-hover:bg-white/20" />
    </button>
  );
}
