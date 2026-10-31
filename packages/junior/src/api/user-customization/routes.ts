import { Hono } from "hono";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import { userCustomizationSchema } from "../schema/user-customization";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import { isExperimentalFeatureEnabled } from "../../chat/experimental";
import {
  readUserCustomization,
  saveUserCustomization,
} from "../../chat/identities/customization";

/**
 * Create routes that read and replace the viewer's customization. They return
 * 404 unless the app enables the `user-customization` experiment.
 */
export function createUserCustomizationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.use("*", async (_context, next) => {
    if (!isExperimentalFeatureEnabled("user-customization")) {
      throwApiError(404, "Resource not found.");
    }
    await next();
  });

  app.get("/", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(userCustomizationSchema, {
      customization: (await readUserCustomization(viewer.id)) ?? "",
    });
  });

  app.put(
    "/",
    requireViewer,
    validateRequest("json", userCustomizationSchema, "Invalid request body."),
    async (context) => {
      const viewer = context.get("viewer");
      const { customization } = context.req.valid("json");
      if (!(await saveUserCustomization(viewer.id, customization))) {
        throwApiError(404, "User not found.");
      }
      return jsonResponse(userCustomizationSchema, { customization });
    },
  );

  return app;
}
