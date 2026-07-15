import { Hono } from "hono";
import { parseParams } from "../http";
import { locationParamsSchema } from "../schema";
import { readLocationDetail } from "./detail";
import { readLocationDirectory } from "./list";

/** Create the HTTP routes owned by the locations API. */
export function createLocationRoutes(): Hono {
  const app = new Hono();

  app.get("/", async () => Response.json(await readLocationDirectory()));
  app.get("/:locationId", async (c) => {
    const { locationId } = parseParams(locationParamsSchema, c.req.param());
    const report = await readLocationDetail(locationId);
    return report
      ? Response.json(report)
      : Response.json({ error: "Location not found." }, { status: 404 });
  });

  return app;
}
