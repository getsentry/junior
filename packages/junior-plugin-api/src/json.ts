import { z } from "zod";

/** JSON value shape accepted by plugin public contracts. */
export type PluginJsonValue =
  | string
  | number
  | boolean
  | null
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue };

/** Runtime schema for JSON values accepted from plugin public contracts. */
export const pluginJsonValueSchema: z.ZodType<PluginJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(pluginJsonValueSchema),
    z.record(z.string(), pluginJsonValueSchema),
  ]),
);
