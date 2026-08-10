import { parseParams, throwApiError } from "../http";
import { defineApiRoute } from "../route";
import {
  personalTokenParamsSchema,
  revokePersonalTokenResponseSchema,
} from "../schema/personal-token";
import { revokePersonalToken } from "../../personal-tokens/store";
import { requireViewer } from "../viewer";

/** Revoke a personal API token owned by the authenticated viewer. */
export default defineApiRoute({
  method: "delete",
  path: "/:id",
  responseSchema: revokePersonalTokenResponseSchema,
  handler: async (c) => {
    const viewer = requireViewer(c);
    const { id } = parseParams(personalTokenParamsSchema, c.req.param());
    if (!(await revokePersonalToken({ email: viewer.email, id }))) {
      throwApiError(404, "Personal API token not found.");
    }
    return { revoked: true as const };
  },
});
