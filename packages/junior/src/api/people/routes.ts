import { Hono } from "hono";
import { parseParams } from "../http";
import { personParamsSchema } from "../schema";
import { readPeopleList } from "./list";
import { readPeopleProfile } from "./profile";

/** Create the HTTP routes owned by the People API. */
export function createPeopleRoutes(): Hono {
  const app = new Hono();

  app.get("/", async () => Response.json(await readPeopleList()));
  app.get("/:email", async (c) => {
    const { email } = parseParams(personParamsSchema, c.req.param());
    return Response.json(await readPeopleProfile(email));
  });

  return app;
}
