/**
 * Google plugin runtime boundary.
 *
 * Junior acts as its own Google Workspace account. A Junior admin connects
 * that account out of band, through the dashboard Admin page or the CLI.
 * Calendar, Docs, Sheets, and Slides tools and link cards use host-owned
 * egress, and the sandbox gets no Google credential.
 */
import {
  defineJuniorPlugin,
  definePluginTool,
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
  GOOGLE_API_DOMAINS,
  googleGrantForEgress,
  issueGoogleCredential,
} from "./credentials";
import { googleCalendarLinks } from "./links/calendar";
import { googleFileLinks } from "./links/files";
import { googleImages } from "./links/thumbnails";
import { createGoogleSetupPage, createGoogleSetupRoutes } from "./setup-routes";
import type { GoogleDb } from "./store";
import {
  createCancelCalendarEventTool,
  cancelCalendarEventToolDefinition,
} from "./tools/cancel-event";
import {
  createCreateGoogleDocTool,
  createGoogleDocToolDefinition,
} from "./tools/create-doc";
import {
  createCreateCalendarEventTool,
  createCalendarEventToolDefinition,
} from "./tools/create-event";
import {
  createFindMeetingTimesTool,
  findMeetingTimesToolDefinition,
} from "./tools/find-meeting-times";
import {
  createInsertGoogleDocContentTool,
  insertGoogleDocContentToolDefinition,
} from "./tools/insert-doc-content";
import {
  createListGoogleFileCommentsTool,
  listGoogleFileCommentsToolDefinition,
} from "./tools/list-file-comments";
import {
  createListCalendarEventsTool,
  listCalendarEventsToolDefinition,
} from "./tools/list-events";
import {
  createReadGoogleFileTool,
  readGoogleFileToolDefinition,
} from "./tools/read-file";
import {
  createReadMeetingTranscriptTool,
  readMeetingTranscriptToolDefinition,
} from "./tools/read-meeting-transcript";
import {
  createReplaceGoogleDocContentTool,
  replaceGoogleDocContentToolDefinition,
} from "./tools/replace-doc-content";
import {
  createReplaceGoogleDocTextTool,
  replaceGoogleDocTextToolDefinition,
} from "./tools/replace-doc-text";
import {
  createSearchGoogleFilesTool,
  searchGoogleFilesToolDefinition,
} from "./tools/search-files";
import {
  createUpdateCalendarEventTool,
  updateCalendarEventToolDefinition,
} from "./tools/update-event";

/** Register Junior's Google Workspace plugin. */
export function googlePlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-google",
    manifest: {
      name: "google",
      displayName: "Google Workspace",
      description:
        "Google Calendar scheduling, Meet transcripts, Google Docs writing, and Google Docs, Sheets, and Slides reading as your own Google Workspace account",
      domains: GOOGLE_API_DOMAINS,
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
    objectLinks: [googleFileLinks, googleCalendarLinks],
    images: googleImages,
    hooks: {
      apiRoutes(ctx) {
        const config = readGoogleConfig();
        return config
          ? createGoogleSetupRoutes({ config, db: ctx.db as GoogleDb })
          : undefined;
      },
      grantForEgress: googleGrantForEgress,
      issueCredential: issueGoogleCredential,
      tools: {
        definitions(): Record<string, PluginToolDefinition> {
          if (!readGoogleConfig()) {
            return {};
          }
          return {
            cancelCalendarEvent: definePluginTool(
              cancelCalendarEventToolDefinition,
            ),
            createCalendarEvent: definePluginTool(
              createCalendarEventToolDefinition,
            ),
            createGoogleDoc: definePluginTool(createGoogleDocToolDefinition),
            findMeetingTimes: definePluginTool(findMeetingTimesToolDefinition),
            insertGoogleDocContent: definePluginTool(
              insertGoogleDocContentToolDefinition,
            ),
            listCalendarEvents: definePluginTool(
              listCalendarEventsToolDefinition,
            ),
            listGoogleFileComments: definePluginTool(
              listGoogleFileCommentsToolDefinition,
            ),
            readGoogleFile: definePluginTool(readGoogleFileToolDefinition),
            readMeetingTranscript: definePluginTool(
              readMeetingTranscriptToolDefinition,
            ),
            replaceGoogleDocContent: definePluginTool(
              replaceGoogleDocContentToolDefinition,
            ),
            replaceGoogleDocText: definePluginTool(
              replaceGoogleDocTextToolDefinition,
            ),
            searchGoogleFiles: definePluginTool(
              searchGoogleFilesToolDefinition,
            ),
            updateCalendarEvent: definePluginTool(
              updateCalendarEventToolDefinition,
            ),
          };
        },
        bind(ctx): Record<string, PluginToolDefinition> {
          const config = readGoogleConfig();
          if (!config) {
            return {};
          }
          const toolContext = {
            accountEmail: config.accountEmail,
            allowedDomains: config.allowedDomains,
            egress: ctx.egress,
            sandbox: ctx.sandbox,
            users: ctx.users,
          };
          return {
            cancelCalendarEvent: createCancelCalendarEventTool(toolContext),
            createCalendarEvent: createCreateCalendarEventTool(toolContext),
            createGoogleDoc: createCreateGoogleDocTool(toolContext),
            findMeetingTimes: createFindMeetingTimesTool(toolContext),
            insertGoogleDocContent:
              createInsertGoogleDocContentTool(toolContext),
            listCalendarEvents: createListCalendarEventsTool(toolContext),
            listGoogleFileComments:
              createListGoogleFileCommentsTool(toolContext),
            readGoogleFile: createReadGoogleFileTool(toolContext),
            readMeetingTranscript: createReadMeetingTranscriptTool(toolContext),
            replaceGoogleDocContent:
              createReplaceGoogleDocContentTool(toolContext),
            replaceGoogleDocText: createReplaceGoogleDocTextTool(toolContext),
            searchGoogleFiles: createSearchGoogleFilesTool(toolContext),
            updateCalendarEvent: createUpdateCalendarEventTool(toolContext),
          };
        },
      },
    },
  });
}
