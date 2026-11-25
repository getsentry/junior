/**
 * The runtime parts of core features, which core runs at fixed sites that
 * the plugin registration shape has no hook for. Core reads them here, so it
 * imports no feature. Each site owns its contract type, and the static
 * system prompt rules are in `./system-prompt`.
 */
import type { TurnContextSource } from "@/chat/agent/prompt";
import type { ParentAgentDetail } from "@/chat/agent-invocations/types";
import type { ConversationContent } from "@/chat/conversations/sql/purge";
import type { CompactionSnapshot } from "@/chat/services/compaction-snapshot";
import { todosConversationContent } from "@/chat/todos/content";
import { parentTodosDetail } from "@/chat/todos/parent-agent";
import { todosCompactionSnapshot } from "@/chat/todos/snapshot";
import { loadTodosTurnContext } from "@/chat/todos/turn-context";

/** The section of the Turn context of a new prompt, after the notes. */
export const CORE_FEATURE_TURN_CONTEXT: TurnContextSource =
  loadTodosTurnContext;

/** The snapshot that each compaction summary keeps. */
export const CORE_FEATURE_COMPACTION_SNAPSHOT: CompactionSnapshot =
  todosCompactionSnapshot;

/** Conversation content that purge deletes with the transcript. */
export const CORE_FEATURE_CONVERSATION_CONTENT: ConversationContent =
  todosConversationContent;

/** Fields of the parent's entry in a child agent's team listing. */
export const CORE_FEATURE_PARENT_AGENT_DETAIL: ParentAgentDetail =
  parentTodosDetail;
