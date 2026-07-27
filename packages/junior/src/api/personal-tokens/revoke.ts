import { parseParams, throwApiError } from "../http";
import { defineApiRoute } from "../route";
import {
  personalTokenParamsSchema,
  revokePersonalTokenResponseSchema,
} from "../schema/personal-token";
import { revokePersonalToken } from "../../personal-tokens/store";

/** Revoke a personal API token owned by the authenticated viewer. */
export default defineApiRoute({
  method: "delete",
  path: "/:id",
  responseSchema: revokePersonalTokenResponseSchema,
  handler: async (c) => {
    const email = c.get("verifiedViewerEmail");
    if (!email) throwApiError(403, "Verified viewer email required.");
    const { id } = parseParams(personalTokenParamsSchema, c.req.param());
    if (!(await revokePersonalToken({ email, id }))) {
      throwApiError(404, "Personal API token not found.");
    }
    return { revoked: true as const };
  },
});
