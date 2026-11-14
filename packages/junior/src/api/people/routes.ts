import { Hono } from "hono";
import { AVATAR_WIDTH } from "@/chat/identities/avatar";
import { readImage } from "@/chat/images/read";
import { jsonResponse, throwApiError } from "../http";
import { imageResponse } from "../images/response";
import type { JuniorApiEnv } from "../route";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  avatarParamsSchema,
  personParamsSchema,
  personalSpendReportSchema,
} from "../schema/person";
import { codePersonReportSchema, personCodeQuerySchema } from "../schema/code";
import { pluginOperationalReportFeedSchema } from "../../reporting-schema";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { readPeopleCode } from "./code";
import { readPeopleList } from "./list";
import { readPeoplePluginReports } from "./plugin-reports";
import { readPeopleProfile } from "./profile";
import { readPersonalSpendFromSql } from "./spend.query";

/** Create the HTTP routes owned by the People API. */
export function createPeopleRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  // Profile photos keep this stable path. The shared image code fetches and
  // scales them, so browsers never load them from Slack or Google.
  app.get(
    "/avatars/:identityId",
    requireViewer,
    validateRequest("param", avatarParamsSchema, "Invalid route parameters."),
    async (context) => {
      const { identityId } = context.req.valid("param");
      const served = await readImage(
        context.get("viewer"),
        { ref: identityId, source: "avatar" },
        AVATAR_WIDTH,
      );
      if (!served) throwApiError(404, "Avatar not found.");
      return imageResponse(served, context.req.query("v") !== undefined);
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
    "/:email/code",
    validateRequest("param", personParamsSchema, "Invalid route parameters."),
    validateRequest("query", personCodeQuerySchema, "Invalid code query."),
    async (context) => {
      const { email } = context.req.valid("param");
      const { offset } = context.req.valid("query");
      return jsonResponse(
        codePersonReportSchema,
        await readPeopleCode(email, offset),
      );
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
