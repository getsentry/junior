import { BRIEF_PROMPT } from "./prompt";

/** Default fast model used until Brief quality tuning selects another model. */
export const DEFAULT_BRIEF_MODEL_ID = "anthropic/claude-haiku-4.5";

/** Default production prompt shared by local replay and background generation. */
export const DEFAULT_BRIEF_PROMPT = BRIEF_PROMPT;
