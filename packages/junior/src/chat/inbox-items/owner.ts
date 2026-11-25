import { sql, type SQL } from "drizzle-orm";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import {
  INBOX_SUBJECT_KINDS,
  pluginSubjectKind,
} from "@/chat/inbox-items/subjects";
import {
  juniorAutomations,
  juniorConversationAnnotations,
  juniorConversations,
  juniorDestinations,
  juniorInboxItems,
  juniorQuestions,
} from "@/db/schema";

// An item stores no owner. Its subject names the owner: a question belongs
// to the Conversation that asked it, a reply and a To-do to their
// Conversation, an Automation alert to its Automation, and a plugin item to
// the Conversation that the plugin's owner table or Annotations map its
// subject id to.
// These expressions read the owner of the `junior_inbox_items` row of the
// query.

const item = juniorInboxItems;

const annotations = juniorConversationAnnotations;

// The Conversation that first saved an Annotation of the subject's object,
// such as the one that created a GitHub issue. Later Conversations that
// change the object add their own Annotations of it.
// `junior_conversation_annotations_subject_idx` serves this lookup.
function annotationOwner(kind: string): SQL {
  return sql`(select ${annotations.conversationId} from ${annotations} where ${annotations.subjectKind} = ${kind} and ${annotations.subjectId} = ${item.subjectId} order by ${annotations.createdAt}, ${annotations.conversationId} limit 1)`;
}

/** SQL: the owner Conversation of a plugin item, from the plugin's table. */
function pluginOwnerCases(): SQL[] {
  return getPlugins().flatMap((plugin) =>
    (plugin.inboxSubjects ?? []).map((subject) => {
      const kind = pluginSubjectKind(plugin.manifest.name, subject.kind);
      if (subject.owner === "annotation") {
        return sql`when ${kind} then ${annotationOwner(kind)}`;
      }
      const { conversationId, subjectId, table } = subject.owner;
      const owner = sql`${sql.identifier(table)}.${sql.identifier(conversationId)}`;
      return sql`when ${kind} then (select ${owner} from ${sql.identifier(table)} where ${sql.identifier(table)}.${sql.identifier(subjectId)} = ${item.subjectId} and ${owner} is not null)`;
    }),
  );
}

/**
 * SQL: the id of the Conversation that owns the item. Null for an
 * Automation alert, and for a subject whose owner row is gone.
 */
export function inboxItemOwnerConversationId(): SQL<string | null> {
  return sql<string | null>`(case ${item.subjectKind}
    when ${INBOX_SUBJECT_KINDS.question} then (select ${juniorQuestions.conversationId} from ${juniorQuestions} where ${juniorQuestions.id} = ${item.subjectId})
    when ${INBOX_SUBJECT_KINDS.reply} then ${item.subjectId}
    when ${INBOX_SUBJECT_KINDS.todo} then regexp_replace(${item.subjectId}, ':[^:]*$', '')
    ${sql.join(pluginOwnerCases(), sql` `)}
  end)`;
}

const isAutomationAlert = sql`${item.subjectKind} = ${INBOX_SUBJECT_KINDS.automation}`;

/** SQL: the kind of the item's owner. */
export function inboxItemOwnerKind(): SQL<"automation" | "conversation"> {
  return sql<
    "automation" | "conversation"
  >`(case when ${isAutomationAlert} then 'automation' else 'conversation' end)`;
}

/** SQL: the id of the item's owner, the Automation or the Conversation. */
export function inboxItemOwnerId(): SQL<string | null> {
  return sql<
    string | null
  >`(case when ${isAutomationAlert} then ${item.subjectId} else ${inboxItemOwnerConversationId()} end)`;
}

// A Conversation's Destination is its root's, as for Conversation access.
// An Automation's Destination is its Slack channel.
function ownerDestination(column: SQL): SQL {
  return sql`(case when ${isAutomationAlert}
    then (select ${column} from ${juniorAutomations} join ${juniorDestinations} on ${juniorDestinations.provider} = 'slack' and ${juniorDestinations.providerTenantId} = ${juniorAutomations.teamId} and ${juniorDestinations.providerDestinationId} = ${juniorAutomations.channelId} where ${juniorAutomations.id} = ${item.subjectId})
    else (select ${column} from ${juniorConversations} owner join ${juniorConversations} root on root.conversation_id = owner.root_conversation_id join ${juniorDestinations} on ${juniorDestinations.id} = root.destination_id where owner.conversation_id = ${inboxItemOwnerConversationId()})
  end)`;
}

/**
 * SQL: `public` when the owner's Destination is public, else `private`.
 * It is live: when the Destination changes, the item follows. A To-do is
 * its assignee's own, so its item is always private.
 */
export function inboxItemVisibility(): SQL<"public" | "private"> {
  return sql<
    "public" | "private"
  >`(case when ${item.subjectKind} <> ${INBOX_SUBJECT_KINDS.todo} and ${ownerDestination(sql`${juniorDestinations.visibility}`)} = 'public' then 'public' else 'private' end)`;
}

/** SQL: the provider of the owner's tenant, null when it has none. */
export function inboxItemTenantProvider(): SQL<string | null> {
  return sql<
    string | null
  >`${ownerDestination(sql`case when ${juniorDestinations.providerTenantId} <> '' then ${juniorDestinations.provider} end`)}`;
}

/** SQL: the owner's provider tenant id, null when it has none. */
export function inboxItemTenantId(): SQL<string | null> {
  return sql<
    string | null
  >`${ownerDestination(sql`nullif(${juniorDestinations.providerTenantId}, '')`)}`;
}
