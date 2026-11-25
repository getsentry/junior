import { useQueryClient } from "@tanstack/react-query";
import pLimit from "p-limit";

import { attachObjectLinkResponseSchema } from "@sentry/junior/api/schema";
import { post } from "../http";
import type { ComposerConversation } from "./ComposerMention";
import { linkedWorkUrls } from "./composerReferences";
import { conversationPath } from "./conversationRoutes";
import {
  conversationDetailQueryKey,
  type ConversationSnapshot,
} from "./queries";

// Attaches that one Message sends at once.
const ATTACH_REQUESTS = 4;

// The API drops only a trailing slash when it compares links.
function linkKey(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Return a function that adds the Conversations, Tasks, and pull requests
 * that a sent Message references to the Conversation's linked work, with
 * one attach each. It skips links that the Conversation already has and
 * the Conversation itself. A composer with no Conversation yet attaches
 * nothing.
 */
export function useAttachLinkedWork(
  conversation: ComposerConversation | undefined,
): (text: string) => void {
  const queryClient = useQueryClient();
  return (text) => {
    if (!conversation) return;
    const { conversationId } = conversation;
    const key = conversationDetailQueryKey(conversationId);
    const detail = queryClient.getQueryData<ConversationSnapshot>(key);
    const skipped = new Set([
      linkKey(`${window.location.origin}${conversationPath(conversationId)}`),
      ...(detail?.annotations ?? []).flatMap((annotation) =>
        annotation.url ? [linkKey(annotation.url)] : [],
      ),
    ]);
    const urls = linkedWorkUrls(text, window.location.origin).filter(
      (url) => !skipped.has(linkKey(url)),
    );
    if (!urls.length) return;
    // A link that does not attach, such as one the viewer cannot see,
    // stays only in the Message.
    void pLimit(ATTACH_REQUESTS)
      .map(urls, (url) =>
        post(
          attachObjectLinkResponseSchema,
          `/api/conversations/${encodeURIComponent(conversationId)}/annotations`,
          { url },
        ).catch(() => undefined),
      )
      .then(() => queryClient.invalidateQueries({ queryKey: key }));
  };
}
