import { readPeopleProfileFromSql } from "./profile.query";
import { actorProfileReportSchema } from "./schema";
import type { ActorProfileReport } from "./schema";
import type { ApiRoute } from "../route";
import { parseParams } from "../http";
import { personParamsSchema } from "../schema";

/** Load one person profile from verified user identities in SQL. */
export async function readPeopleProfile(
  email: string,
  options: { verifiedViewerEmail?: string } = {},
): Promise<ActorProfileReport> {
  return actorProfileReportSchema.parse(
    await readPeopleProfileFromSql(email, options),
  );
}

/** Serve one People profile endpoint. */
export default {
  method: "get",
  path: "/:email",
  handler: async (c) => {
    const { email } = parseParams(personParamsSchema, c.req.param());
    const verifiedViewerEmail = c.get("verifiedViewerEmail");
    return Response.json(
      await readPeopleProfile(
        email,
        verifiedViewerEmail ? { verifiedViewerEmail } : {},
      ),
    );
  },
} satisfies ApiRoute;
