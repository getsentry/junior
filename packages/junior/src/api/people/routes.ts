import { Hono } from "hono";
import { readAvatarImage } from "@/chat/identities/avatar";
import { getDb } from "@/chat/db";
import { getStateAdapter } from "@/chat/state/adapter";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  avatarParamsSchema,
  personParamsSchema,
  personalSpendReportSchema,
} from "../schema/person";
import { codePersonReportSchema } from "../schema/code";
import {
  personReplyTimesQuerySchema,
  personReplyTimesReportSchema,
} from "../schema/reply-times";
import { pluginOperationalReportFeedSchema } from "../../reporting-schema";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { readPeopleCode } from "./code";
import { readPeopleList } from "./list";
import { readPeoplePluginReports } from "./plugin-reports";
import { readPeopleProfile } from "./profile";
import { readPersonReplyTimes } from "./reply-times";
import { readPersonalSpendFromSql } from "./spend.query";

// A versioned photo path never changes its bytes. `private` keeps photos out
// of shared caches, because the route needs a signed-in viewer.
const AVATAR_IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** Create the HTTP routes owned by the People API. */
export function createPeopleRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  // Serve profile photos from Junior, so browsers never load them from
  // Slack or Google. A photo path has the version of its photo, so the
  // browser keeps a current versioned photo and checks any other request.
  app.get(
    "/avatars/:identityId",
    requireViewer,
    validateRequest("param", avatarParamsSchema, "Invalid route parameters."),
    async (context) => {
      const { identityId } = context.req.valid("param");
      const avatar = await readAvatarImage(
        getDb(),
        getStateAdapter(),
        identityId,
      );
      if (!avatar) throwApiError(404, "Avatar not found.");
      const etag = `"${avatar.version}"`;
      const headers = {
        "cache-control":
          context.req.query("v") === avatar.version
            ? AVATAR_IMMUTABLE_CACHE_CONTROL
            : "private, no-cache",
        etag,
      };
      if (context.req.header("if-none-match") === etag) {
        return new Response(null, { headers, status: 304 });
      }
      return new Response(Buffer.from(avatar.image.data, "base64"), {
        headers: {
          ...headers,
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": avatar.image.contentType,
          "x-content-type-options": "nosniff",
        },
      });
    },
  );

  app.get("/me/spend", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(
      personalSpendReportSchema,
      await readPersonalSpendFromSql(viewer.email),
    );
  });

  app.get("/", async () =>
    jsonResponse(actorDirectoryReportSchema, await readPeopleList()),
  );

  app.get(
    "/:email/plugin-reports",
    requireViewer,
    validateRequest("param", personParamsSchema, "Invalid route parameters."),
    async (context) => {
      const { email } = context.req.valid("param");
      const viewer = context.get("viewer");
      return jsonResponse(
        pluginOperationalReportFeedSchema,
        await readPeoplePluginReports({ email, viewer }),
      );
    },
  );

  app.get(
    "/:email/reply-times",
    requireViewer,
    validateRequest("param", personParamsSchema, "Invalid route parameters."),
    validateRequest(
      "query",
      personReplyTimesQuerySchema,
      "Invalid query parameters.",
    ),
    async (context) => {
      const { email } = context.req.valid("param");
      const { days } = context.req.valid("query");
      const report = await readPersonReplyTimes({
        days,
        email,
        viewer: context.get("viewer"),
      });
      // Only the person reads their reply times. Any other viewer gets the
      // answer for a person that does not exist.
      if (!report) throwApiError(404, "Reply times not found.");
      return jsonResponse(personReplyTimesReportSchema, report);
    },
  );

  app.get(
    "/:email/code",
    validateRequest("param", personParamsSchema, "Invalid route parameters."),
    async (context) => {
      const { email } = context.req.valid("param");
      return jsonResponse(codePersonReportSchema, await readPeopleCode(email));
    },
  );

  app.get(
    "/:email",
    validateRequest("param", personParamsSchema, "Invalid route parameters."),
    async (context) => {
      const { email } = context.req.valid("param");
      const viewer = context.get("viewer");
      return jsonResponse(
        actorProfileReportSchema,
        await readPeopleProfile(email, viewer ? { viewer } : {}),
      );
    },
  );

  return app;
}
