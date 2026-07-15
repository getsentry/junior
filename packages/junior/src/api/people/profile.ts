import { readPeopleProfileFromSql } from "./profile.query";
import { actorProfileReportSchema } from "./schema";
import type { ActorProfileReport } from "./schema";
import type { ApiRoute } from "../route";
import { parseParams } from "../http";
import { personParamsSchema } from "../schema";

/** Load one person profile from verified user identities in SQL. */
export async function readPeopleProfile(
  email: string,
): Promise<ActorProfileReport> {
  return actorProfileReportSchema.parse(await readPeopleProfileFromSql(email));
}

/** Serve one People profile endpoint. */
export default {
  method: "get",
  path: "/:email",
  handler: async (c) => {
    const { email } = parseParams(personParamsSchema, c.req.param());
    return Response.json(await readPeopleProfile(email));
  },
} satisfies ApiRoute;
