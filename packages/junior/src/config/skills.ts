// The skills group: extra directories to discover skills in.
import path from "node:path";
import * as z from "zod";
import type { Env } from "@/config/fields";

/** Skill discovery settings. */
export const skillsSchema = z
  .strictObject({
    /** Extra skill roots, searched before the default and plugin roots. */
    dirs: z.array(z.string()).default([]),
  })
  .prefault({});

/** Read the skills group from env. `SKILL_DIRS` uses the OS path delimiter. */
export function readSkillsEnv(env: Env): z.input<typeof skillsSchema> {
  return { dirs: env["SKILL_DIRS"]?.split(path.delimiter).filter(Boolean) };
}
