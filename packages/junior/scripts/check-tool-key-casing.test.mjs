import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkToolKeyCasingSources } from "./check-tool-key-casing.mjs";

describe("checkToolKeyCasingSources", () => {
  it("accepts snake_case input and output keys", () => {
    const errors = checkToolKeyCasingSources({
      "src/tool.ts": `
        zodTool({
          inputSchema: z.object({ automation_id: z.string() }).strict(),
          outputSchema: resultSchema.extend({
            objectCards: z.array(cardSchema),
            next_run_at: z.string(),
          }),
        });
      `,
    });

    assert.deepEqual(errors, []);
  });

  it("rejects camelCase keys in inline, nested, and shorthand schemas", () => {
    const errors = checkToolKeyCasingSources({
      "src/tool.ts": `
        const deploymentId = z.string();
        definePluginTool({
          inputSchema: z.object({
            deploymentId,
            edits: z.array(z.object({ oldText: z.string() })),
          }),
        });
      `,
    });

    assert.deepEqual(errors, [
      'src/tool.ts:5: tool schema key "deploymentId" must be snake_case',
      'src/tool.ts:6: tool schema key "oldText" must be snake_case',
    ]);
  });

  it("follows schema names across files and into helper returns", () => {
    const errors = checkToolKeyCasingSources(
      {
        "src/schedule.ts": `
          export const scheduleSchema = z
            .object({ dayOfMonth: z.number() })
            .superRefine((value, context) => {
              context.addIssue({ code: "custom", fatalHint: true });
            });
        `,
        "src/tools/create.ts": `
          import { scheduleSchema } from "@/schedule";
          function inputSchema() {
            const local = 1;
            return z.object({ schedule: scheduleSchema });
          }
          zodTool({ inputSchema: inputSchema() });
        `,
      },
      { app: "src" },
    );

    assert.deepEqual(errors, [
      'src/schedule.ts:3: tool schema key "dayOfMonth" must be snake_case',
    ]);
  });
});
