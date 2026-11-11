import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./timestamps";

/** One code change of a Walkthrough, as the provider described it at its commits. */
export type WalkthroughCodeChange = {
  number: number;
  title: string;
  body: string;
  url: string;
  headSha: string;
  baseSha: string;
  additions: number;
  deletions: number;
};

type WalkthroughVersionStatus = "generating" | "ready" | "failed";

/**
 * One generated version of a Walkthrough. The document itself is in object
 * storage at `documentKey`; this row finds it and keeps lineage.
 */
export const juniorWalkthroughVersions = pgTable(
  "junior_walkthrough_versions",
  {
    id: uuid("id").primaryKey(),
    /** The previous version this one builds on. */
    parentVersionId: uuid("parent_version_id"),
    provider: text("provider").notNull(),
    /** Repository name as the provider writes it, such as `owner/name`. */
    repository: text("repository").notNull(),
    /**
     * Stable key of the code changes and commits, so an unchanged stack
     * reuses its version instead of generating again.
     */
    snapshotKey: text("snapshot_key").notNull(),
    /** The stack, bottom first, at the commits this version describes. */
    codeChanges: jsonb("code_changes")
      .$type<WalkthroughCodeChange[]>()
      .notNull(),
    /**
     * The hidden Conversation whose Turn generates this version. Lists hide
     * Conversations that appear here. No foreign key: the version claims
     * its snapshot before the Conversation exists, so two clicks never
     * create two Conversations.
     */
    generationConversationId: text("generation_conversation_id"),
    /** The Conversation that opened the code change, when it was readable. */
    sourceConversationId: text("source_conversation_id"),
    status: text("status").$type<WalkthroughVersionStatus>().notNull(),
    documentKey: text("document_key"),
    failureReason: text("failure_reason"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamptz("created_at").notNull(),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    // One live version per snapshot: a second click joins the running or
    // finished one. Failed versions do not block a retry.
    uniqueIndex("junior_walkthrough_versions_snapshot_idx")
      .on(table.provider, table.repository, table.snapshotKey)
      .where(sql`${table.status} <> 'failed'`),
    // Serves the list filter that hides generation Conversations.
    uniqueIndex("junior_walkthrough_versions_generation_conversation_idx").on(
      table.generationConversationId,
    ),
    index("junior_walkthrough_versions_parent_idx").on(table.parentVersionId),
  ],
);

/** How a reviewer answered one decision. */
export type WalkthroughAnswerValue = "agree" | "change";

/**
 * One reviewer's answer to one decision in one version. Answers are not
 * copied to later versions.
 */
export const juniorWalkthroughAnswers = pgTable(
  "junior_walkthrough_answers",
  {
    versionId: uuid("version_id").notNull(),
    /** Decision id in the document. Ids stay the same across versions. */
    decisionId: text("decision_id").notNull(),
    userId: text("user_id").notNull(),
    value: text("value").$type<WalkthroughAnswerValue>().notNull(),
    note: text("note"),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_walkthrough_answers_pk",
      columns: [table.versionId, table.userId, table.decisionId],
    }),
    foreignKey({
      name: "junior_walkthrough_answers_version_id_fk",
      columns: [table.versionId],
      foreignColumns: [juniorWalkthroughVersions.id],
    }).onDelete("cascade"),
  ],
);

/**
 * One reviewer's questions about one version: a private, hidden Conversation
 * that answers from the Walkthrough. Lists hide Conversations that appear
 * here. No foreign key to the Conversation: the row exists before the first
 * question creates it, so lists never show it.
 */
export const juniorWalkthroughQuestions = pgTable(
  "junior_walkthrough_questions",
  {
    versionId: uuid("version_id").notNull(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "junior_walkthrough_questions_pk",
      columns: [table.versionId, table.userId],
    }),
    // Serves the list filter and the Turn lookup by Conversation.
    uniqueIndex("junior_walkthrough_questions_conversation_idx").on(
      table.conversationId,
    ),
    foreignKey({
      name: "junior_walkthrough_questions_version_id_fk",
      columns: [table.versionId],
      foreignColumns: [juniorWalkthroughVersions.id],
    }).onDelete("cascade"),
  ],
);
