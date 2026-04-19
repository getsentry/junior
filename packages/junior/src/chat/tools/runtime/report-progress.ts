import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";

/** Create the internal tool the model uses for sparse major-phase updates. */
export function createReportProgressTool() {
  return tool({
    description:
      "Update assistant status when you start a major new phase of work. Use for sparse phase changes such as researching, reading, executing, reviewing, or drafting. Do not call this for every tool or minor substep.",
    inputSchema: Type.Object({
      phase: Type.Union([
        Type.Literal("thinking"),
        Type.Literal("researching"),
        Type.Literal("reading"),
        Type.Literal("executing"),
        Type.Literal("reviewing"),
        Type.Literal("drafting"),
      ]),
      detail: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 40,
          description:
            "Optional short user-facing detail, such as docs, tests, source files, or reply.",
        }),
      ),
    }),
  });
}
