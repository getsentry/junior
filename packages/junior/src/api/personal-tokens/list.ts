import { defineApiRoute } from "../route";
import { personalTokenListSchema } from "../schema/personal-token";
import { listPersonalTokens } from "../../personal-tokens/store";
import { requireViewer } from "../viewer";

/** List active personal API tokens owned by the authenticated viewer. */
export default defineApiRoute({
  method: "get",
  path: "/",
  responseSchema: personalTokenListSchema,
  handler: async (c) => {
    const viewer = requireViewer(c);
    return { tokens: await listPersonalTokens(viewer.email) };
  },
});
