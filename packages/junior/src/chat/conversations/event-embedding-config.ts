import { getChatConfig } from "@/chat/config";

/** Return whether event embeddings and meaning search are enabled. */
export function isEventEmbeddingsEnabled(): boolean {
  return getChatConfig().eventEmbeddings.enabled === true;
}
