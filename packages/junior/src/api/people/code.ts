import { findUserByEmail } from "@/chat/plugins/viewer";
import { readPersonCodeOverview } from "../code/overview";
import { codePersonReportSchema } from "../schema/code";

/** Read person-scoped native code activity for one People profile. */
export async function readPeopleCode(email: string) {
  const subject = await findUserByEmail(email);
  if (!subject) {
    const now = new Date();
    return codePersonReportSchema.parse({
      activityDays: [],
      generatedAt: now.toISOString(),
      summary: {
        closed: 0,
        created: 0,
        merged: 0,
        open: 0,
      },
      windowEnd: now.toISOString(),
      windowStart: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
    });
  }
  return await readPersonCodeOverview({ userId: subject.id });
}
