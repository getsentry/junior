import { Hono } from "hono";
import { decodeImageId } from "@/chat/images/ids";
import { readImage } from "@/chat/images/read";
import { throwApiError } from "../http";
import { imageResponse } from "./response";
import type { JuniorApiEnv } from "../route";
import { imageParamsSchema, imageQuerySchema } from "../schema/image";
import { validateRequest } from "../validation";
import { requireViewer } from "../viewer";

/**
 * Create the route that serves external images from Junior, so browsers
 * never load them from another host. The path has a signed id, never the
 * address of the image.
 */
export function createImageRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.get(
    "/:id",
    requireViewer,
    validateRequest("param", imageParamsSchema, "Invalid route parameters."),
    validateRequest("query", imageQuerySchema, "Invalid image width."),
    async (context) => {
      const image = decodeImageId(context.req.valid("param").id);
      const { v, w } = context.req.valid("query");
      const served =
        image && (await readImage(context.get("viewer"), image, w));
      if (!served) throwApiError(404, "Image not found.");
      return imageResponse(served, Boolean(v));
    },
  );
  return app;
}
