import { BRIEF_PROMPT } from "./prompt";

/** Resolve the configured fast model when a Brief run starts. */
export async function defaultBriefModelId(): Promise<string> {
  const { botConfig } = await import("@/chat/config");
  return botConfig.fastModelId;
}

/** Default production prompt shared by local replay and background generation. */
export const DEFAULT_BRIEF_PROMPT = BRIEF_PROMPT;
