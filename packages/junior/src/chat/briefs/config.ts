import { defaultModelId } from "@/chat/model-profile";
import { BRIEF_PROMPT } from "./prompt";

/** Resolve the configured default model when a Brief run starts. */
export async function defaultBriefModelId(): Promise<string> {
  const { botConfig } = await import("@/chat/config");
  return defaultModelId(botConfig);
}

/** Default production prompt shared by local replay and background generation. */
export const DEFAULT_BRIEF_PROMPT = BRIEF_PROMPT;
