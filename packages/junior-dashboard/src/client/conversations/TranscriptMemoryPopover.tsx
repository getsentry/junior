import { Brain } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Link } from "react-router";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { formatMessageTimestamp, memoryPath } from "../format";
import { cn } from "../styles";
import type { TranscriptViewMessage } from "../types";
import {
  anchorMemories,
  memoryAnchorKey,
  useConversationMemoryState,
  type ConversationMemory,
  type ConversationMemoryState,
  type MemoryAnchor,
} from "./conversationMemory";
import { MemoryLinkIcons } from "./MemoryIcons";
import { memoryRecallContent } from "./turnContext";

function memoryCount(count: number): string {
  return `${count} ${count === 1 ? "memory" : "memories"}`;
}

/**
 * Open one transcript spot's memories in a popover, so the transcript keeps
 * its length. The page owns which popover is open, so the details panel can
 * open one too.
 */
function MemoryPopover(props: {
  anchor: MemoryAnchor;
  label: string;
  memories: ConversationMemory[];
  state: ConversationMemoryState;
  trigger: ReactElement;
}) {
  const { anchor, state } = props;
  const open =
    state.open?.source === anchor.source && state.open.turnId === anchor.turnId;
  const highlightId = open ? state.open?.memoryId : undefined;
  return (
    <Popover
      onOpenChange={(next) => state.setOpen(next ? anchor : undefined)}
      open={open}
    >
      <PopoverTrigger
        data-memory-anchor={memoryAnchorKey(anchor)}
        render={props.trigger}
      />
      <PopoverContent
        align="start"
        aria-label={props.label}
        className="max-h-[min(28rem,var(--available-height))] w-96 p-1.5"
      >
        <ul className="m-0 grid list-none divide-y divide-dashboard-border-subtle p-0">
          {props.memories.map((memory) => (
            <li className="py-1 first:pt-0 last:pb-0" key={memory.id}>
              <Link
                className={cn(
                  "group grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-md px-2.5 py-2 no-underline transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus",
                  memory.id === highlightId && "bg-dashboard-fill-strong",
                )}
                ref={
                  memory.id === highlightId
                    ? (node) => node?.scrollIntoView({ block: "nearest" })
                    : undefined
                }
                to={memoryPath(memory.id)}
              >
                <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text">
                  {memory.content}
                </p>
                <MemoryLinkIcons private={memory.visibility === "private"} />
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Show the memories that a prompt recalled, under that prompt. One prompt can
 * start more than one Turn, and each Turn recalls, so each gets a chip.
 */
export function TranscriptRecalledMemories(props: {
  className?: string;
  message: TranscriptViewMessage;
}) {
  const state = useConversationMemoryState();
  const anchors = [
    ...new Set(
      props.message.contexts
        ?.filter((context) => memoryRecallContent(context))
        .map((context) => context.turnId),
    ),
  ].flatMap((turnId) => {
    const anchor = { source: "recalled", turnId } as const;
    const memories = anchorMemories(state?.list, anchor);
    return memories.length > 0 ? [{ anchor, memories }] : [];
  });
  if (!state || anchors.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", props.className)}>
      {anchors.map(({ anchor, memories }) => {
        const label = `Recalled ${memoryCount(memories.length)}`;
        return (
          <MemoryPopover
            anchor={anchor}
            key={anchor.turnId}
            label={label}
            memories={memories}
            state={state}
            trigger={
              <button
                className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md border border-dashboard-border-subtle bg-transparent px-2 font-sans text-xs text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus aria-expanded:bg-dashboard-fill-strong aria-expanded:text-dashboard-text"
                type="button"
              >
                <Brain aria-hidden="true" size={13} strokeWidth={1.8} />
                {label}
              </button>
            }
          />
        );
      })}
    </div>
  );
}

/**
 * Show the memories that one Turn captured. Without memory state or a list
 * for the Turn, such as in a nested transcript, show `fallback`.
 */
export function TranscriptCapturedMemories(props: {
  fallback: ReactNode;
  timestamp?: number;
  turnId?: string;
}) {
  const state = useConversationMemoryState();
  const anchor = props.turnId
    ? ({ source: "captured", turnId: props.turnId } as const)
    : undefined;
  const memories = anchor ? anchorMemories(state?.list, anchor) : [];
  if (!state || !anchor || memories.length === 0) return props.fallback;
  const label = `Captured ${memoryCount(memories.length)}`;
  const timestamp = formatMessageTimestamp(props.timestamp);
  return (
    <MemoryPopover
      anchor={anchor}
      label={label}
      memories={memories}
      state={state}
      trigger={
        <button
          className="-mx-2 -my-1.5 grid w-[calc(100%+1rem)] cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-sans transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus aria-expanded:bg-dashboard-fill-hover max-md:grid-cols-[minmax(0,1fr)]"
          type="button"
        >
          <span className="text-sm font-medium leading-6 text-dashboard-text">
            {label}
          </span>
          {timestamp ? (
            <span className="text-xs leading-6 tabular-nums text-dashboard-text-muted max-md:hidden">
              {timestamp}
            </span>
          ) : null}
        </button>
      }
    />
  );
}
