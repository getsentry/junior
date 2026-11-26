/**
 * Attach a linked object to a Conversation's linked work for one person: a
 * `resource_link` Annotation and a Conversation note. The dashboard attach
 * route and the heartbeat attach of sent links (`sent-links.ts`) both use
 * this one rule.
 */
import { objectPresentation, type User } from "@sentry/junior-plugin-api";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { resolveObjectLinkNow } from "@/api/objects/resolve";
import { getConversationStore, getDb } from "@/chat/db";
import {
  createPluginAnnotations,
  listConversationAnnotations,
} from "@/chat/plugins/annotations";
import { addConversationNote } from "./notes";
import { acceptsWebMessages } from "./web-input";

/**
 * What one attach did. `not_participant`: the person cannot write to the
 * Conversation. `no_web_input`: the Conversation takes no input from people,
 * such as a Task. `not_found`: no object that the person can see now.
 */
export type ObjectAttachOutcome =
  | "attached"
  | "unchanged"
  | "not_participant"
  | "no_web_input"
  | "not_found";

// Only a trailing slash is dropped: another page of an object is another link.
function sameLink(left: string, right: string): boolean {
  const key = (url: string) => url.replace(/\/+$/, "");
  return key(left) === key(right);
}

/**
 * Attach the object of one link to a Conversation for one participant. The
 * Annotation and the Conversation note save no title. The note tells the
 * next Turn the type and the read tool of the object, so the agent reads it
 * live. Nothing is attached when the person cannot write to the
 * Conversation, the Conversation takes no web input from people (a Task),
 * or the person cannot see the object now.
 */
export async function attachObjectLinkForUser(
  viewer: User,
  conversationId: string,
  url: string,
): Promise<ObjectAttachOutcome> {
  const db = getDb();
  const access = await readConversationAccessFromSql(
    db,
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) return "not_participant";
  // An attach is a person's input, so it follows the rule for web Messages.
  // A root participant can read a Task, but must not add notes to its Turns.
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation || !acceptsWebMessages(conversation)) {
    return "no_web_input";
  }
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  // The card cache can be up to a minute old, so access is read again.
  const resolved = parsed && (await resolveObjectLinkNow(viewer, parsed));
  // A person is not work that the agent can read.
  if (!parsed || !resolved || resolved.object.objectType === "person") {
    return "not_found";
  }
  const { linkType, object } = resolved;
  const link = object.url ?? parsed.href;

  const annotations = await listConversationAnnotations(db, conversationId);
  if (
    annotations.some(
      (annotation) =>
        (annotation.url && sameLink(annotation.url, link)) ||
        (annotation.plugin === linkType.owner && annotation.key === object.key),
    )
  ) {
    return "unchanged";
  }

  // Readers of the Conversation see the note, so it names only the type.
  // The agent learns the title when it reads the object.
  const type = object.displayType ?? objectPresentation(object).label;
  const article = /^[aeiou]/i.test(type) ? "an" : "a";
  const readTool = linkType.readTool?.(object);
  // The note goes first. Its key makes it safe to add again, so a retry
  // after a failed Annotation write still tells the next Turn once.
  await addConversationNote({
    conversationId,
    createdAtMs: Date.now(),
    key: `object_attached:${linkType.owner}:${object.key}`,
    text: [
      `${viewer.displayName ?? viewer.email} attached ${article} ${type} (${link}) to this Conversation.`,
      readTool
        ? `Read it live with \`${readTool}\` when the work needs its content.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  });
  await createPluginAnnotations({
    conversationId,
    db,
    plugin: linkType.owner,
  }).upsert({
    kind: "resource_link",
    key: object.key,
    // The bare link is the label. The title would show to readers who
    // cannot open the object.
    label: link.slice(0, 256),
    objectType: object.objectType,
    url: link,
  });
  return "attached";
}
