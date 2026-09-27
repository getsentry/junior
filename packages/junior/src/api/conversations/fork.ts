import type { User } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { resolveRootVisibility } from "@/chat/conversations/sql/privacy";
import { withConversationMutationLock } from "@/chat/conversations/sql/store";
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
  return withConversationMutationLock(
    getSqlExecutor(),
    conversationId,
    async () => {
      await resolveRootVisibility(getSqlExecutor(), conversationId);
      const access = (
        await readConversationAccessFromSql(getDb(), [conversationId], viewer)
      ).get(conversationId);
      if (!access?.canViewPrivateContent)
        throwApiError(404, "Conversation not found.");
      try {
        return await forkConversation({
          actor: webActorFromEmail(viewer.email, {
            fullName: viewer.displayName,
          }),
          conversationId,
          attachmentStorage,
          ...body,
          visibility: access.visibility === "public" ? "public" : "private",
        });
      } catch (error) {
        if (error instanceof ConversationForkError)
          throwApiError(409, error.message);
        throw error;
      }
    },
  );
}
