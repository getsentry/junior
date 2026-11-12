import { ArrowRight, BookmarkPlus, Brain, ChevronRight } from "lucide-react";

import { Button } from "../components/ui/button";
import { dashboardDisclosureChevronClass } from "../styles";
import type {
  ConversationMemoryEntry,
  ConversationMemoryList,
} from "./conversationMemory";
import { DetailsCard } from "./DetailsList";
import { PrivateMemoryIcon } from "./MemoryIcons";

/** Count the distinct memories that a Conversation recalled and captured. */
function conversationMemoryCounts(list: ConversationMemoryList) {
  const ids = (source: "captured" | "recalled") =>
    new Set(
      list.events
        .filter((event) => event.source === source)
        .flatMap((event) => event.memoryIds),
    ).size;
  return { captured: ids("captured"), recalled: ids("recalled") };
}

/** Show memory counts in one row that opens the full memory list. */
export function ConversationMemoryCard(props: {
  list: ConversationMemoryList;
  onOpen(): void;
}) {
  const counts = conversationMemoryCounts(props.list);
  const summary = [
    counts.recalled ? `${counts.recalled} recalled` : undefined,
    counts.captured ? `${counts.captured} captured` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <DetailsCard title="Memories">
      <Button
        className="group -mx-1.5 -my-1 flex min-h-8 w-[calc(100%+0.75rem)] items-center justify-between gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm tabular-nums text-foreground focus-visible:-outline-offset-2"
        onClick={props.onOpen}
        variant="ghost"
        size="bare"
      >
        {summary}
        <ChevronRight
          aria-hidden="true"
          className={dashboardDisclosureChevronClass}
        />
      </Button>
    </DetailsCard>
  );
}

/** One memory with its full text, its visibility, and a jump to its Turn. */
function MemoryCard(props: {
  entry: ConversationMemoryEntry;
  onSelect(entry: ConversationMemoryEntry & { turnId: string }): void;
}) {
  const { entry } = props;
  const { turnId } = entry;
  return (
    <li className="grid overflow-hidden rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel">
      {/* Break long URLs so the card keeps the panel width. */}
      <p className="m-0 whitespace-pre-wrap px-3 py-2.5 text-sm leading-relaxed text-dashboard-text [overflow-wrap:anywhere]">
        {entry.memory.content}
      </p>
      <div className="flex min-h-8 items-center justify-between gap-2 border-t border-dashboard-border-subtle bg-dashboard-fill-faint px-3 py-1 text-xs text-dashboard-text-muted">
        {entry.memory.visibility === "private" ? (
          <PrivateMemoryIcon />
        ) : (
          <span />
        )}
        {turnId ? (
          <Button
            className="-mr-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium hover:bg-dashboard-fill-hover focus-visible:-outline-offset-2"
            onClick={() => props.onSelect({ ...entry, turnId })}
            size="bare"
            variant="ghost"
          >
            Go to message
            <ArrowRight aria-hidden="true" size={13} />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * List every memory that a Conversation recalled or captured, with its full
 * text. Selecting one shows it in the transcript.
 */
export function ConversationMemoryEntries(props: {
  entries: ConversationMemoryEntry[];
  onSelect(entry: ConversationMemoryEntry & { turnId: string }): void;
}) {
  const groups = (["recalled", "captured"] as const)
    .map((source) => ({
      entries: props.entries.filter((entry) => entry.source === source),
      source,
    }))
    .filter((group) => group.entries.length > 0);
  return (
    <div className="grid gap-5">
      {groups.map((group) => (
        <section className="grid gap-2" key={group.source}>
          <h3 className="m-0 flex items-center gap-1.5 font-sans text-xs font-semibold text-dashboard-text">
            {group.source === "recalled" ? (
              <Brain aria-hidden="true" size={13} strokeWidth={1.8} />
            ) : (
              <BookmarkPlus aria-hidden="true" size={13} strokeWidth={1.8} />
            )}
            {group.source === "recalled" ? "Recalled" : "Captured"}
            <span className="font-normal tabular-nums text-dashboard-text-muted">
              {group.entries.length}
            </span>
          </h3>
          <ol className="m-0 grid list-none gap-2 p-0">
            {group.entries.map((entry) => (
              <MemoryCard
                entry={entry}
                key={`${entry.source}:${entry.memory.id}`}
                onSelect={props.onSelect}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
