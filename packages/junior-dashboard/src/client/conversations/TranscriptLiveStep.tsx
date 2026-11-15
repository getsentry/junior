import { useEffect, useState } from "react";
import { Bot, Globe, Sparkles, SquareTerminal, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { ShimmerText } from "../components/ShimmerText";
import { DisplayText } from "../display-text/DisplayText";
import type { TranscriptViewToolCallPart } from "../types";
import { toolCallPreview } from "./toolCallPreview";
import type { RenderedTranscriptEntry } from "./transcriptRenderModel";

/**
 * Pick what a running Turn shows while its activity is closed: the latest
 * reasoning, and a tool call that runs after it. Without a running tool
 * call, Junior is between steps.
 */
export function liveActivityStep(entries: readonly RenderedTranscriptEntry[]): {
  reasoning?: { key: string; text: string };
  tool?: TranscriptViewToolCallPart | undefined;
} {
  let tool: TranscriptViewToolCallPart | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "tool") {
      if (entry.part.status === "running") tool ??= entry.part;
      continue;
    }
    if (entry.kind !== "reasoning") continue;
    const text = entry.part.redacted ? "" : entry.part.text.trim();
    if (text) return { reasoning: { key: entry.key, text }, tool };
  }
  return { tool };
}

// Say what a running tool call does, like "Running" a command.
const toolActions: Record<string, { icon: LucideIcon; verb: string }> = {
  bash: { icon: SquareTerminal, verb: "Running" },
  executeTool: { icon: Wrench, verb: "Calling" },
  loadSkill: { icon: Sparkles, verb: "Loading" },
  spawnAgent: { icon: Bot, verb: "Starting" },
  webFetch: { icon: Globe, verb: "Reading" },
  webSearch: { icon: Globe, verb: "Searching" },
};

/** Show the latest step of a running Turn: its reasoning, then what it does now. */
export function LiveActivityStep(props: {
  entries: readonly RenderedTranscriptEntry[];
}) {
  const { reasoning, tool } = liveActivityStep(props.entries);
  const action = tool
    ? (toolActions[tool.name] ?? { icon: Wrench, verb: tool.name })
    : undefined;
  const preview = tool ? toolCallPreview(tool.name, tool.input) : null;
  const Icon = action?.icon;
  return (
    <div className="mt-1.5 grid min-w-0 gap-1.5">
      {reasoning ? (
        // A new step replaces the text, so it fades in instead of jumping.
        // Streamed text grows the same step, so it keeps the node.
        <div
          className="line-clamp-3 text-sm leading-relaxed text-dashboard-text-muted motion-safe:animate-in motion-safe:fade-in-0"
          key={reasoning.key}
        >
          <DisplayText inline links={false} text={reasoning.text} />
        </div>
      ) : null}
      {/* The tool call takes the place of "Thinking" while it runs. Only
          this line is announced, so streamed reasoning does not repeat. */}
      <div
        aria-live="polite"
        className="flex min-w-0 items-center gap-1.5 text-sm leading-6 text-dashboard-text-muted"
      >
        {Icon ? (
          <Icon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-dashboard-text-faint"
            strokeWidth={2}
          />
        ) : null}
        <ShimmerText active className="shrink-0">
          {action?.verb ?? "Thinking"}
        </ShimmerText>
        {preview ? (
          <code className="min-w-0 truncate font-mono text-xs">{preview}</code>
        ) : null}
      </div>
    </div>
  );
}

/** Format whole seconds, so a ticking time does not jump in width. */
function formatWorkingTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Tick the time a running Turn has worked since `startMs`, every second. */
export function useWorkingTime(
  startMs: number | undefined,
): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startMs === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startMs]);
  return startMs === undefined ? undefined : formatWorkingTime(now - startMs);
}
