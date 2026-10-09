/**
 * Google plugin runtime boundary.
 *
 * Junior acts as its own Google Workspace account. A Junior admin connects
 * that account out of band, through the dashboard Admin page or the CLI.
 * Calendar and Meet tools use host-owned egress, and the sandbox gets no
 * Google credential.
 */
import {
  defineJuniorPlugin,
  type PluginRegistration,
  type PluginToolDefinition,
} from "@sentry/junior-plugin-api";
import { createGoogleCliCommand } from "./cli";
import {
  GOOGLE_ACCOUNT_EMAIL_ENV,
  GOOGLE_ALLOWED_DOMAINS_ENV,
  GOOGLE_CLIENT_ID_ENV,
  GOOGLE_CLIENT_SECRET_ENV,
  readGoogleConfig,
} from "./config";
import {
  GOOGLE_API_DOMAIN,
  GOOGLE_MEET_API_DOMAIN,
  googleGrantForEgress,
  issueGoogleCredential,
} from "./credentials";
import { createGoogleSetupPage, createGoogleSetupRoutes } from "./setup-routes";
import type { GoogleDb } from "./store";
import { createCancelCalendarEventTool } from "./tools/cancel-event";
import { createCreateCalendarEventTool } from "./tools/create-event";
import { createFindMeetingTimesTool } from "./tools/find-meeting-times";
import { createListCalendarEventsTool } from "./tools/list-events";
import { createUpdateCalendarEventTool } from "./tools/update-event";

/** Register Junior's Google Workspace plugin. */
export function googlePlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-google",
    manifest: {
      name: "google",
      displayName: "Google Workspace",
      description:
        "Google Calendar scheduling as Junior's own Google Workspace account",
      domains: [GOOGLE_API_DOMAIN, GOOGLE_MEET_API_DOMAIN],
      envVars: {
        [GOOGLE_CLIENT_ID_ENV]: {},
        [GOOGLE_CLIENT_SECRET_ENV]: {},
        [GOOGLE_ACCOUNT_EMAIL_ENV]: {},
        [GOOGLE_ALLOWED_DOMAINS_ENV]: {},
      },
    },
    cli: {
      commands: [createGoogleCliCommand()],
    },
    userPages: [createGoogleSetupPage()],
    hooks: {
      apiRoutes(ctx) {
        const config = readGoogleConfig();
        return config
          ? createGoogleSetupRoutes({ config, db: ctx.db as GoogleDb })
          : undefined;
      },
      grantForEgress: googleGrantForEgress,
      issueCredential: issueGoogleCredential,
      tools(ctx): Record<string, PluginToolDefinition> {
        const config = readGoogleConfig();
        if (!config) {
          return {};
        }
        const toolContext = {
          accountEmail: config.accountEmail,
          allowedDomains: config.allowedDomains,
          egress: ctx.egress,
          users: ctx.users,
        };
        return {
          cancelCalendarEvent: createCancelCalendarEventTool(toolContext),
          createCalendarEvent: createCreateCalendarEventTool(toolContext),
          findMeetingTimes: createFindMeetingTimesTool(toolContext),
          listCalendarEvents: createListCalendarEventsTool(toolContext),
          updateCalendarEvent: createUpdateCalendarEventTool(toolContext),
        };
      },
    },
  });
}
