import type { Hono } from "hono";
import { jsonResponse, type JuniorApiVariables } from "@sentry/junior/api";
import {
  actorDirectoryReportSchema,
  actorProfileReportSchema,
  codePersonReportSchema,
  personalSpendReportSchema,
  personCardReportSchema,
  personParamsSchema,
  pluginOperationalReportFeedSchema,
} from "@sentry/junior/api/schema";
import { errorResponse } from "./errors";
import {
  readMockPeopleCode,
  readMockPeopleDirectory,
  readMockPeoplePluginReports,
  readMockPeopleProfile,
  readMockPersonalSpend,
} from "./fixtures";
import { readMockPersonCard } from "./objects";
import { registerMockPeopleSearchRoutes } from "./people-search";

/** Add the mock People routes: the directory, profiles, and person cards. */
export function mountMockPeopleRoutes(
  app: Hono<{ Variables: JuniorApiVariables }>,
): void {
  app.get("/people", () =>
    jsonResponse(actorDirectoryReportSchema, readMockPeopleDirectory()),
  );
  // Before `/people/:email`, which would take `search` as an email.
  registerMockPeopleSearchRoutes(app);
  app.get("/people/me/spend", (context) => {
    const email = context.get("viewer")?.email;
    const report = email ? readMockPersonalSpend(email) : undefined;
    return report
      ? jsonResponse(personalSpendReportSchema, report)
      : errorResponse("Person not found.", 404);
  });
  app.get("/people/:email/plugin-reports", (c) => {
    const params = personParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    return jsonResponse(
      pluginOperationalReportFeedSchema,
      readMockPeoplePluginReports(params.data.email),
    );
  });
  app.get("/people/:email/card", (c) => {
    const params = personParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    return jsonResponse(
      personCardReportSchema,
      readMockPersonCard(new URL(c.req.url).origin, params.data.email),
    );
  });
  app.get("/people/:email/code", (c) => {
    const params = personParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const report = readMockPeopleCode(params.data.email);
    return report
      ? jsonResponse(codePersonReportSchema, report)
      : errorResponse("Person not found.", 404);
  });
  app.get("/people/:email", (c) => {
    const params = personParamsSchema.safeParse(c.req.param());
    if (!params.success) {
      return errorResponse("Invalid route parameters.", 400);
    }
    const { email } = params.data;
    const report = readMockPeopleProfile(email);
    return report
      ? jsonResponse(actorProfileReportSchema, report)
      : errorResponse("Person not found.", 404);
  });
}
