import { throwApiError } from "../http";
import { defineApiRoute } from "../route";
import { personalTokenListSchema } from "../schema/personal-token";
import { listPersonalTokens } from "../../personal-tokens/store";

/** List active personal API tokens owned by the authenticated viewer. */
export default defineApiRoute({
  method: "get",
  path: "/",
  responseSchema: personalTokenListSchema,
  handler: async (c) => {
    const email = c.get("verifiedViewerEmail");
    if (!email) throwApiError(403, "Verified viewer email required.");
    return { tokens: await listPersonalTokens(email) };
  },
});
