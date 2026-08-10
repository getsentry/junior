import { readPeopleProfileFromSql } from "./profile.query";
import { actorProfileReportSchema } from "../schema/person";
import type { ActorProfileReport } from "../schema/person";
import { defineApiRoute } from "../route";
import { parseParams } from "../http";
import { personParamsSchema } from "../schema/person";
import { getViewer } from "../viewer";

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
export default defineApiRoute({
  method: "get",
  path: "/:email",
  responseSchema: actorProfileReportSchema,
  handler: async (c) => {
    const { email } = parseParams(personParamsSchema, c.req.param());
    const viewer = getViewer(c);
    return readPeopleProfile(
      email,
      viewer ? { verifiedViewerEmail: viewer.email } : {},
    );
  },
});
