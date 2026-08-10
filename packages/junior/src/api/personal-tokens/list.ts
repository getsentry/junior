import { defineApiRoute } from "../route";
import { personalTokenListSchema } from "../schema/personal-token";
import { listPersonalTokens } from "../../personal-tokens/store";
/** List active personal API tokens owned by the authenticated viewer. */
export default defineApiRoute({
  auth: true,
  method: "get",
  path: "/",
  responseSchema: personalTokenListSchema,
  handler: async (c) => {
    const viewer = c.get("viewer");
    return { tokens: await listPersonalTokens(viewer.email) };
  },
});
