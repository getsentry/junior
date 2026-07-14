import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { juniorAgentSteps } from "./agent-steps";
import { juniorConversations } from "./conversations";

/**
 * Durable user-request boundary within a conversation. Model identity remains
 * owned by the context-epoch markers in `junior_agent_steps`; `starting_seq`
 * anchors the turn before any of its execution steps are appended.
 */
export const juniorConversationTurns = pgTable(
  "junior_conversation_turns",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => juniorConversations.conversationId),
    turnId: text("turn_id").notNull(),
    startingSeq: integer("starting_seq").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.turnId] }),
    foreignKey({
      columns: [table.conversationId, table.startingSeq],
      foreignColumns: [juniorAgentSteps.conversationId, juniorAgentSteps.seq],
      name: "junior_conversation_turns_starting_step_fk",
    }),
  ],
);
