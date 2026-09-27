import type { User } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import {
  ConversationForkError,
  forkConversation,
} from "@/chat/conversations/fork";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { throwApiError } from "../http";
import type { ForkConversationBody } from "../schema/conversation";
import { readConversationAccessFromSql } from "./access";

/** Fork only history the signed-in viewer can read, without starting work. */
export async function forkConversationForViewer(
  viewer: User,
  conversationId: string,
  body: ForkConversationBody,
  attachmentStorage: AttachmentStorage,
) {
  try {
    return await forkConversation({
      actor: webActorFromEmail(viewer.email, { fullName: viewer.displayName }),
      conversationId,
      attachmentStorage,
      ...body,
      authorize: async () => {
        // During publication this lock keeps the visibility decision stable.
        await resolveRootVisibility(getSqlExecutor(), conversationId);
        const access = (
          await readConversationAccessFromSql(getDb(), [conversationId], viewer)
        ).get(conversationId);
        if (!access?.canViewPrivateContent)
          throwApiError(404, "Conversation not found.");
        return access.visibility === "public" ? "public" : "private";
      },
    });
  } catch (error) {
    if (error instanceof ConversationForkError)
      throwApiError(409, error.message);
    throw error;
  }
}
