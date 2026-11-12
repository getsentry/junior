import { BookmarkPlus, History } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { createContext, useContext } from "react";
import type { ReactElement, ReactNode } from "react";
import { Link } from "react-router";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { formatMessageTimestamp, memoryPath } from "../format";
import { cn } from "../styles";
import { Button } from "../components/ui/button";
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
import { chipClass } from "./TranscriptTasksLine";
import type { TranscriptTurnFooter } from "./transcriptListRows";
import { memoryRecallContent } from "./turnContext";

function memoryCount(count: number): string {
  return `${count} ${count === 1 ? "memory" : "memories"}`;
}

// Recalled memories look back; captured ones are newly saved.
const sourceIcons: Record<MemoryAnchor["source"], LucideIcon> = {
  captured: BookmarkPlus,
  recalled: History,
};

/**
 * The prompts whose recalled memories show under the reply that ends their
 * Turn, so the prompt does not show them too.
 */
export const RecalledOnReplyContext = createContext<
  ReadonlySet<TranscriptViewMessage>
>(new Set());

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
  const onReply = useContext(RecalledOnReplyContext).has(props.message);
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
  if (onReply || !state || anchors.length === 0) return null;
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
              <Button
                className="inline-flex h-6 items-center gap-1.5 rounded-md border border-dashboard-border-subtle px-2 text-xs hover:bg-dashboard-fill-hover focus-visible:-outline-offset-2 aria-expanded:bg-dashboard-fill-strong aria-expanded:text-dashboard-text"
                size="bare"
                variant="ghost"
              >
                <History aria-hidden="true" size={13} strokeWidth={1.8} />
                {label}
              </Button>
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
        <Button
          className="-mx-2 -my-1.5 grid w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-dashboard-fill-hover focus-visible:-outline-offset-2 aria-expanded:bg-dashboard-fill-hover max-md:grid-cols-[minmax(0,1fr)]"
          size="bare"
          variant="ghost"
        >
          <span className="text-sm font-medium leading-6 text-dashboard-text">
            {label}
          </span>
          {timestamp ? (
            <span className="text-xs leading-6 tabular-nums text-dashboard-text-muted max-md:hidden">
              {timestamp}
            </span>
          ) : null}
        </Button>
      }
    />
  );
}

type TurnMemoryChip = {
  anchor?: MemoryAnchor;
  key: string;
  label: string;
  memories: ConversationMemory[];
};

/**
 * List the memory chips of the reply that ends a Turn: what its prompt
 * recalled, then what the Turn captured. Without memory state, such as in a
 * nested transcript, a capture keeps its event title and opens nothing.
 */
export function useTurnMemoryChips(
  footer: TranscriptTurnFooter,
): TurnMemoryChip[] {
  const state = useConversationMemoryState();
  const recalled = [
    ...new Set(
      footer.prompt?.message.contexts
        ?.filter((context) => memoryRecallContent(context))
        .map((context) => context.turnId),
    ),
  ].flatMap((turnId): TurnMemoryChip[] => {
    const anchor = { source: "recalled", turnId } as const;
    const memories = anchorMemories(state?.list, anchor);
    return memories.length > 0
      ? [
          {
            anchor,
            key: memoryAnchorKey(anchor),
            label: `Recalled ${memoryCount(memories.length)}`,
            memories,
          },
        ]
      : [];
  });
  const captured = footer.captures.map((entry): TurnMemoryChip => {
    const anchor = entry.part.turnId
      ? ({ source: "captured", turnId: entry.part.turnId } as const)
      : undefined;
    const memories = anchor ? anchorMemories(state?.list, anchor) : [];
    return state && anchor && memories.length > 0
      ? {
          anchor,
          key: entry.key,
          label: `Captured ${memoryCount(memories.length)}`,
          memories,
        }
      : { key: entry.key, label: entry.part.presentation.title, memories: [] };
  });
  return [...recalled, ...captured];
}

/** Show a Turn's memory chips under its reply. A click opens the memories. */
export function TranscriptTurnMemories(props: { chips: TurnMemoryChip[] }) {
  const state = useConversationMemoryState();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {props.chips.map((chip) => {
        const Icon = sourceIcons[chip.anchor?.source ?? "captured"];
        const content = (
          <>
            <Icon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-dashboard-text-faint"
              strokeWidth={2}
            />
            <span className="min-w-0 truncate">{chip.label}</span>
          </>
        );
        if (!state || !chip.anchor) {
          return (
            <span className={cn(chipClass, "cursor-default")} key={chip.key}>
              {content}
            </span>
          );
        }
        return (
          <MemoryPopover
            anchor={chip.anchor}
            key={chip.key}
            label={chip.label}
            memories={chip.memories}
            state={state}
            trigger={
              <Button className={chipClass} size="bare" variant="ghost">
                {content}
              </Button>
            }
          />
        );
      })}
    </div>
  );
}
