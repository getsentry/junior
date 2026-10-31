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
import { pluginOperationalReportFeedSchema } from "../../reporting-schema";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { readPeopleCode } from "./code";
import { readPeopleList } from "./list";
import { readPeoplePluginReports } from "./plugin-reports";
import { readPeopleProfile } from "./profile";
import { createPersonalSpendReader } from "./spend";

/** Create the HTTP routes owned by the People API. */
export function createPeopleRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  const readPersonalSpend = createPersonalSpendReader();

  // Serve profile photos from Junior, so browsers never load them from
  // Slack or Google. The browser keeps each photo for a day.
  app.get(
    "/avatars/:identityId",
    requireViewer,
    validateRequest("param", avatarParamsSchema, "Invalid route parameters."),
    async (context) => {
      const { identityId } = context.req.valid("param");
      const image = await readAvatarImage(
        getDb(),
        getStateAdapter(),
        identityId,
      );
      if (!image) throwApiError(404, "Avatar not found.");
      return new Response(Buffer.from(image.data, "base64"), {
        headers: {
          "cache-control": "private, max-age=86400",
          "content-security-policy": "default-src 'none'; sandbox",
          "content-type": image.contentType,
          "x-content-type-options": "nosniff",
        },
      });
    },
  );

  app.get("/me/spend", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(
      personalSpendReportSchema,
      await readPersonalSpend(viewer.email),
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
