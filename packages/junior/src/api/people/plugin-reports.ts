import type { User } from "@sentry/junior-plugin-api";
import {
  pluginOperationalReportFeedSchema,
  type PluginOperationalReportFeed,
} from "@/reporting-schema";
import { findUserByEmail } from "@/chat/plugins/viewer";

/** Read sanitized person-scoped plugin reports for one profile subject. */
export async function readPeoplePluginReports(args: {
  email: string;
  viewer: User;
}): Promise<PluginOperationalReportFeed> {
  const nowMs = Date.now();
  const subject = await findUserByEmail(args.email);
  if (!subject) {
    return pluginOperationalReportFeedSchema.parse({
      generatedAt: new Date(nowMs).toISOString(),
      reports: [],
      source: "plugins",
    });
  }
  const { getPluginProfileReports } = await import(
    "@/chat/plugins/agent-hooks"
  );
  return pluginOperationalReportFeedSchema.parse({
    generatedAt: new Date(nowMs).toISOString(),
    reports: await getPluginProfileReports({
      nowMs,
      subject,
      viewer: args.viewer,
    }),
    source: "plugins",
  });
}
