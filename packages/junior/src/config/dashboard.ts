// The dashboard group: the `createApp({ dashboard })` settings that links to
// the dashboard use.
import * as z from "zod";

/** Where dashboard links point. Unset or disabled means no links. */
export const dashboardSchema = z
  .strictObject({
    basePath: z.string().optional(),
    baseURL: z.string().optional(),
    disabled: z.boolean().optional(),
  })
  .optional();
