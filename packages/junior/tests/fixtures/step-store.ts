import {
  agentStepEntrySchema,
  type AgentStepStore,
  type NewAgentStep,
  type StoredAgentStep,
} from "@/chat/conversations/history";

/**
 * In-memory {@link AgentStepStore} for tests that need step/projection wiring
 * without a SQL backend. Mirrors the SQL store's seq/epoch assignment.
 */
export function createMemoryAgentStepStore(): AgentStepStore {
  const byConversation = new Map<string, StoredAgentStep[]>();
  const read = (id: string): StoredAgentStep[] => byConversation.get(id) ?? [];
  const nextSeq = (steps: StoredAgentStep[]): number =>
    steps.length ? Math.max(...steps.map((step) => step.seq)) + 1 : 0;
  const maxEpoch = (steps: StoredAgentStep[]): number =>
    steps.length ? Math.max(...steps.map((step) => step.contextEpoch)) : 0;

  return {
    async append(conversationId: string, steps: NewAgentStep[]): Promise<void> {
      const existing = read(conversationId);
      let seq = nextSeq(existing);
      const epoch = maxEpoch(existing);
      const rows = steps.map((step) => ({
        seq: seq++,
        contextEpoch: epoch,
        createdAtMs: step.createdAtMs,
        entry: agentStepEntrySchema.parse(step.entry),
      }));
      byConversation.set(conversationId, [...existing, ...rows]);
    },
    async startEpoch(conversationId, opts): Promise<void> {
      const existing = read(conversationId);
      const epoch = (existing.length ? maxEpoch(existing) : -1) + 1;
      let seq = nextSeq(existing);
      const rows: StoredAgentStep[] = [
        {
          seq: seq++,
          contextEpoch: epoch,
          createdAtMs: Date.now(),
          entry: { type: "context_epoch_started", reason: opts.reason },
        },
        ...opts.messages.map((message) => ({
          seq: seq++,
          contextEpoch: epoch,
          createdAtMs: message.createdAtMs,
          entry: agentStepEntrySchema.parse({
            type: "pi_message" as const,
            message: message.message,
            ...(message.provenance ? { provenance: message.provenance } : {}),
          }),
        })),
      ];
      byConversation.set(conversationId, [...existing, ...rows]);
    },
    async loadCurrentEpoch(conversationId): Promise<StoredAgentStep[]> {
      const existing = read(conversationId);
      if (existing.length === 0) {
        return [];
      }
      const epoch = maxEpoch(existing);
      return existing
        .filter((step) => step.contextEpoch === epoch)
        .sort((left, right) => left.seq - right.seq);
    },
    async loadHistory(conversationId): Promise<StoredAgentStep[]> {
      return [...read(conversationId)].sort(
        (left, right) => left.seq - right.seq,
      );
    },
  };
}
