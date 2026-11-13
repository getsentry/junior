import { objectPresentation, type User } from "@sentry/junior-plugin-api";
import { addConversationNote } from "@/chat/conversations/notes";
import { getDb } from "@/chat/db";
import {
  createPluginAnnotations,
  listConversationAnnotations,
} from "@/chat/plugins/annotations";
import { readConversationAccessFromSql } from "../conversations/access";
import { throwApiError } from "../http";
import type { AttachObjectLinkResponse } from "../schema/object-link";
import { resolveObjectLinkNow } from "./resolve";

// Only a trailing slash is dropped: another page of an object is another link.
function sameLink(left: string, right: string): boolean {
  const key = (url: string) => url.replace(/\/+$/, "");
  return key(left) === key(right);
}

// A short title keeps the URL inside the length limit of a note.
const NOTE_TITLE_CHARS = 120;

/**
 * Attach a linked object to a Conversation for one participant. The
 * Annotation saves only the link: its URL, object type, and title. The next
 * Turn gets a Conversation note that names the read tool of the object, so
 * the agent reads it live. Nothing is attached when the viewer cannot write
 * to the Conversation or cannot see the object now.
 */
export async function attachObjectLink(
  viewer: User,
  conversationId: string,
  url: string,
): Promise<AttachObjectLinkResponse> {
  const db = getDb();
  const access = await readConversationAccessFromSql(
    db,
    [conversationId],
    viewer,
  );
  if (!access.get(conversationId)?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  // The card cache can be up to a minute old, so access is read again.
  const resolved = parsed && (await resolveObjectLinkNow(viewer, parsed));
  // A person is not work that the agent can read.
  if (!parsed || !resolved || resolved.object.objectType === "person") {
    throwApiError(404, "Object not found.");
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
    return { status: "unchanged" };
  }

  const type = object.displayType ?? objectPresentation(object).label;
  const title =
    object.title.length > NOTE_TITLE_CHARS
      ? `${object.title.slice(0, NOTE_TITLE_CHARS - 1)}…`
      : object.title;
  const readTool = linkType.readTool?.(parsed);
  // The note goes first. Its key makes it safe to add again, so a retry
  // after a failed Annotation write still tells the next Turn once.
  await addConversationNote({
    conversationId,
    createdAtMs: Date.now(),
    key: `object_attached:${linkType.owner}:${object.key}`,
    text: [
      `${viewer.displayName ?? viewer.email} attached the ${type} "${title}" (${link}) to this Conversation.`,
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
    label: object.title.slice(0, 256),
    objectType: object.objectType,
    url: link,
  });
  return { status: "attached" };
}
