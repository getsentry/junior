import { Hono } from "hono";
import { jsonResponse } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  personParamsSchema,
  personalSpendReportSchema,
} from "../schema/person";
import { pluginOperationalReportFeedSchema } from "../../reporting-schema";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { readPeopleList } from "./list";
import { readPeoplePluginReports } from "./plugin-reports";
import { readPeopleProfile } from "./profile";
import { createPersonalSpendReader } from "./spend";

/** Create the HTTP routes owned by the People API. */
export function createPeopleRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  const readPersonalSpend = createPersonalSpendReader();

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
