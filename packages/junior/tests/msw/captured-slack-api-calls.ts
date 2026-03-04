import { getCapturedSlackApiCalls, type CapturedSlackApiCall } from "./handlers/slack-api";

export function readCapturedSlackApiCalls(): CapturedSlackApiCall[] {
  return getCapturedSlackApiCalls();
}

export type { CapturedSlackApiCall };
