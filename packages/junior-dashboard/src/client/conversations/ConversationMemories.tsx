import { ChevronRight } from "lucide-react";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { dashboardDisclosureChevronClass } from "../styles";
import type {
  ConversationMemoryEntry,
  ConversationMemoryList,
} from "./conversationMemory";
import { DetailsCard } from "./DetailsList";

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
      <button
        className="group -mx-1.5 -my-1 flex min-h-8 w-[calc(100%+0.75rem)] items-center justify-between gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm tabular-nums text-dashboard-text transition-colors hover:bg-dashboard-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
        onClick={props.onOpen}
        type="button"
      >
        {summary}
        <ChevronRight
          aria-hidden="true"
          className={dashboardDisclosureChevronClass}
        />
      </button>
    </DetailsCard>
  );
}

/**
 * Map each loaded Turn to the prompt that started it, so a memory can say
 * where it came from. A Turn starts from its last user input message.
 */
export function turnPrompts(
  events: ConversationDetailReport["events"] | undefined,
): Map<string, string> {
  const texts = new Map<string, string>();
  const prompts = new Map<string, string>();
  for (const { data } of events ?? []) {
    if (data.type === "message" && data.role === "user" && data.text) {
      texts.set(data.messageId, data.text);
    }
    if (data.type === "turn_lifecycle" && data.state === "started") {
      const prompt = data.inputMessageIds
        ?.map((id) => texts.get(id))
        .filter((text) => text !== undefined)
        .at(-1);
      if (prompt) prompts.set(data.turnId, prompt);
    }
  }
  return prompts;
}

/**
 * List every memory that a Conversation recalled or captured, with its full
 * text. Selecting one shows it in the transcript.
 */
export function ConversationMemoryEntries(props: {
  entries: ConversationMemoryEntry[];
  onSelect(entry: ConversationMemoryEntry & { turnId: string }): void;
  prompts: Map<string, string>;
}) {
  return (
    <ol className="m-0 grid list-none gap-2 p-0">
      {props.entries.map((entry) => {
        const { turnId } = entry;
        const prompt = turnId ? props.prompts.get(turnId) : undefined;
        const source =
          entry.source === "recalled"
            ? prompt
              ? `Recalled for “${prompt}”`
              : "Recalled"
            : prompt
              ? `Captured after “${prompt}”`
              : "Captured";
        const body = (
          <>
            <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text">
              {entry.memory.content}
            </p>
            <span className="flex min-w-0 items-center gap-2 text-xs text-dashboard-text-muted">
              <span className="min-w-0 truncate">{source}</span>
              {entry.memory.visibility === "private" ? (
                <span className="shrink-0">· Private</span>
              ) : null}
            </span>
          </>
        );
        const className =
          "grid w-full gap-1.5 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface-panel px-3 py-2.5 text-left font-sans";
        return (
          <li key={`${entry.source}:${entry.memory.id}`}>
            {turnId ? (
              <button
                className={`${className} cursor-pointer transition-colors hover:bg-dashboard-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus`}
                onClick={() => props.onSelect({ ...entry, turnId })}
                type="button"
              >
                {body}
              </button>
            ) : (
              <div className={className}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
