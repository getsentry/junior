// The config defaults group: `createApp({ configDefaults })`, install-wide
// defaults for plugin config keys.
import * as z from "zod";
import { optionCheck } from "@/config/fields";

/**
 * Install-wide defaults keyed by plugin config key. They are cloned, so a
 * later change to the object that the host passed does not reach config.
 */
export const configDefaultsSchema = z
  .unknown()
  .optional()
  .transform((defaults, ctx): Record<string, unknown> => {
    if (defaults === undefined) {
      return {};
    }
    if (
      typeof defaults !== "object" ||
      defaults === null ||
      Array.isArray(defaults)
    ) {
      ctx.addIssue({
        code: "custom",
        ...optionCheck(
          "configDefaults must be an object keyed by plugin config key",
        ),
      });
      return z.NEVER;
    }
    return structuredClone(Object.fromEntries(Object.entries(defaults)));
  });
