import { Hono } from "hono";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  createPersonalTokenBodySchema,
  createdPersonalTokenSchema,
  personalTokenListSchema,
  personalTokenParamsSchema,
  revokePersonalTokenResponseSchema,
} from "../schema/personal-token";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";
import {
  createPersonalToken,
  listPersonalTokens,
  revokePersonalToken,
} from "../../personal-tokens/store";

/** Create authenticated native personal-token list and action routes. */
export function createPersonalTokenRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", requireViewer, async (context) => {
    const viewer = context.get("viewer");
    return jsonResponse(personalTokenListSchema, {
      tokens: await listPersonalTokens(viewer.email),
    });
  });

  app.post(
    "/",
    requireViewer,
    validateRequest(
      "json",
      createPersonalTokenBodySchema,
      "Invalid request body.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const body = context.req.valid("json");
      return jsonResponse(
        createdPersonalTokenSchema,
        await createPersonalToken({ email: viewer.email, name: body.name }),
      );
    },
  );

  app.delete(
    "/:id",
    requireViewer,
    validateRequest(
      "param",
      personalTokenParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const viewer = context.get("viewer");
      const { id } = context.req.valid("param");
      if (!(await revokePersonalToken({ email: viewer.email, id }))) {
        throwApiError(404, "Personal API token not found.");
      }
      return jsonResponse(revokePersonalTokenResponseSchema, {
        revoked: true as const,
      });
    },
  );

  return app;
}
