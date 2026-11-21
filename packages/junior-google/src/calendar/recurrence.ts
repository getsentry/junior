import * as z from "zod";

/** How a new event repeats. */
export const repeatSchema = z
  .object({
    frequency: z
      .enum(["weekdays", "weekly", "monthly"])
      .describe(
        "`weekdays` repeats Monday to Friday. `weekly` repeats on the start's weekday. `monthly` repeats on the start's day of the month.",
      ),
    interval: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(1)
      .describe(
        "Repeat every N weeks or months. 2 with `weekly` means every other week. Ignored for `weekdays`.",
      ),
    count: z
      .number()
      .int()
      .min(2)
      .max(200)
      .optional()
      .describe("Number of occurrences. Omit when the series has no end."),
  })
  .strict();

type Repeat = z.infer<typeof repeatSchema>;

/** Build the Google recurrence rule for a repeating event. */
export function recurrenceRule(repeat: Repeat): string {
  const parts =
    repeat.frequency === "weekdays"
      ? ["FREQ=WEEKLY", "BYDAY=MO,TU,WE,TH,FR"]
      : [
          `FREQ=${repeat.frequency === "weekly" ? "WEEKLY" : "MONTHLY"}`,
          ...(repeat.interval > 1 ? [`INTERVAL=${repeat.interval}`] : []),
        ];
  if (repeat.count) parts.push(`COUNT=${repeat.count}`);
  return `RRULE:${parts.join(";")}`;
}
