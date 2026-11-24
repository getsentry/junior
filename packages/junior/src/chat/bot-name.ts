import { toOptionalTrimmed } from "@/chat/optional-string";

/**
 * Resolve the name Junior uses for itself: `name`, then `JUNIOR_BOT_NAME`,
 * then `junior`. A build passes `juniorNitro({ botName })` as `name`.
 */
export function resolveBotName(
  name: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (name !== undefined) {
    const trimmed = toOptionalTrimmed(name);
    if (!trimmed) {
      throw new Error("botName must not be empty");
    }
    return trimmed;
  }
  return toOptionalTrimmed(env["JUNIOR_BOT_NAME"]) ?? "junior";
}
