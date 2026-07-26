import { readSkillReports } from "../reporting";
import { defineApiRoute } from "./route";
import { skillReportsSchema } from "./schema";

/** Serve the skills discovered for the current Junior runtime. */
export default defineApiRoute({
  method: "get",
  path: "/api/skills",
  responseSchema: skillReportsSchema,
  handler: readSkillReports,
});
