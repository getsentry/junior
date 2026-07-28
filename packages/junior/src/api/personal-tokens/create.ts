import { parseBody, throwApiError } from "../http";
import { defineApiRoute } from "../route";
import {
  createPersonalTokenBodySchema,
  createdPersonalTokenSchema,
} from "../schema/personal-token";
import { createPersonalToken } from "../../personal-tokens/store";

/** Create a personal API token for the authenticated viewer. */
export default defineApiRoute({
  method: "post",
  path: "/",
  responseSchema: createdPersonalTokenSchema,
  handler: async (c) => {
    const email = c.get("verifiedViewerEmail");
    if (!email) throwApiError(403, "Verified viewer email required.");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch (error) {
      throwApiError(400, "Invalid request body.", error);
    }
    const body = parseBody(createPersonalTokenBodySchema, input);
    return createPersonalToken({ email, name: body.name });
  },
});
