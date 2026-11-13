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
  type ConversationMemoryList,
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

/** A memory chip that opens the memories of one transcript spot. */
type AnchorChip = {
  anchor: MemoryAnchor;
  key: string;
  label: string;
  memories: ConversationMemory[];
};

/** A memory chip. Without an anchor, it shows only its label. */
export type MemoryChip =
  | AnchorChip
  | { anchor?: undefined; key: string; label: string };

const sourceVerbs: Record<MemoryAnchor["source"], string> = {
  captured: "Captured",
  recalled: "Recalled",
};

function anchorChip(
  list: ConversationMemoryList | undefined,
  anchor: MemoryAnchor,
): AnchorChip | undefined {
  const memories = anchorMemories(list, anchor);
  if (memories.length === 0) return undefined;
  return {
    anchor,
    key: memoryAnchorKey(anchor),
    label: `${sourceVerbs[anchor.source]} ${memoryCount(memories.length)}`,
    memories,
  };
}

// One prompt can start more than one Turn, and each Turn recalls, so each
// gets a chip.
function recalledChips(
  list: ConversationMemoryList | undefined,
  message: TranscriptViewMessage | undefined,
): AnchorChip[] {
  const turnIds = new Set(
    message?.contexts
      ?.filter((context) => memoryRecallContent(context))
      .map((context) => context.turnId),
  );
  return [...turnIds].flatMap(
    (turnId) => anchorChip(list, { source: "recalled", turnId }) ?? [],
  );
}

function capturedChip(
  list: ConversationMemoryList | undefined,
  turnId: string | undefined,
): AnchorChip | undefined {
  return turnId ? anchorChip(list, { source: "captured", turnId }) : undefined;
}

/** Show memory chips. A chip with an anchor opens its memories. */
export function TranscriptMemoryChips(props: {
  chips: MemoryChip[];
  className?: string;
  state: ConversationMemoryState | undefined;
}) {
  const { state } = props;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5",
        props.className,
      )}
    >
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
              <Button
                className={cn(
                  chipClass,
                  "aria-expanded:bg-dashboard-surface-hover aria-expanded:text-dashboard-text",
                )}
                size="bare"
                variant="ghost"
              >
                {content}
              </Button>
            }
          />
        );
      })}
    </div>
  );
}

/**
 * Show the memories that a prompt recalled, under that prompt, unless the
 * reply that ends its Turn shows them.
 */
export function TranscriptRecalledMemories(props: {
  className?: string;
  message: TranscriptViewMessage;
}) {
  const state = useConversationMemoryState();
  const onReply = useContext(RecalledOnReplyContext).has(props.message);
  const chips =
    onReply || !state ? [] : recalledChips(state.list, props.message);
  if (chips.length === 0) return null;
  return (
    <TranscriptMemoryChips
      chips={chips}
      className={props.className}
      state={state}
    />
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
  const chip = state ? capturedChip(state.list, props.turnId) : undefined;
  if (!state || !chip) return props.fallback;
  const timestamp = formatMessageTimestamp(props.timestamp);
  return (
    <MemoryPopover
      anchor={chip.anchor}
      label={chip.label}
      memories={chip.memories}
      state={state}
      trigger={
        <Button
          className="-mx-2 -my-1.5 grid w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-dashboard-fill-hover focus-visible:-outline-offset-2 aria-expanded:bg-dashboard-fill-hover max-md:grid-cols-[minmax(0,1fr)]"
          size="bare"
          variant="ghost"
        >
          <span className="text-sm font-medium leading-6 text-dashboard-text">
            {chip.label}
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

/**
 * List a Turn's memory chips for the reply that ends it: what its prompt
 * recalled, then what the Turn captured. Without a memory list, such as in a
 * nested or redacted transcript, a capture shows only its event title.
 */
export function turnMemoryChips(
  footer: TranscriptTurnFooter,
  list: ConversationMemoryList | undefined,
): MemoryChip[] {
  return [
    ...recalledChips(list, footer.prompt?.message),
    ...footer.captures.map((entry): MemoryChip => {
      const chip = capturedChip(list, entry.part.turnId);
      return chip
        ? { ...chip, key: entry.key }
        : { key: entry.key, label: entry.part.presentation.title };
    }),
  ];
}
