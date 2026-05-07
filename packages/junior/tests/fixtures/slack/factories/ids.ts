export const TEST_CHANNEL_ID = "C_TEST";
export const TEST_DM_CHANNEL_ID = "D_TEST";
export const TEST_USER_ID = "U_TEST";
export const TEST_BOT_USER_ID = "U_BOT";
export const TEST_THREAD_TS = "1700000000.000";
export const TEST_THREAD_ID = `slack:${TEST_CHANNEL_ID}:${TEST_THREAD_TS}`;
export const TEST_MESSAGE_TS = "1700000000.100";
export const TEST_CANVAS_ID = "F_CANVAS_TEST";
export const TEST_LIST_ID = "L_TEST";
export const TEST_FILE_ID = "F_FILE_TEST";
export const TEST_SECTION_ID = "S_TEST";

export function slackThreadId(channelId = TEST_CHANNEL_ID, threadTs = TEST_THREAD_TS): string {
  return `slack:${channelId}:${threadTs}`;
}

export function slackTimestamp(sequence = 0): string {
  const clamped = Math.max(0, sequence);
  return `1700000000.${String(clamped).padStart(3, "0")}`;
}

export function slackId(prefix: "C" | "D" | "U" | "F" | "L" | "S", sequence = 1): string {
  const suffix = String(Math.max(1, sequence)).padStart(3, "0");
  return `${prefix}_TEST_${suffix}`;
}
