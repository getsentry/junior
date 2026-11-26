import { getChatConfig } from "@/chat/config";

export function shouldEmitDevAgentTrace(): boolean {
  return getChatConfig().development.enabled;
}
