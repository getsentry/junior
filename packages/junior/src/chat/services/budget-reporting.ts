import { logWarn } from "@/chat/logging";
import { incrementStat } from "@/stats";
import {
  getBudgetAttributes,
  type BudgetExceeded,
} from "@/chat/services/budgets";

/** Record one exceeded budget without allowing reporting failure to affect work. */
export async function reportBudgetExceeded(
  budget: BudgetExceeded,
): Promise<void> {
  logWarn("system.budget.exceeded", getBudgetAttributes(budget));
  if (budget.outcome !== "stop" || !process.env.DATABASE_URL) {
    return;
  }
  try {
    await incrementStat({
      namespace: "junior",
      metric: "budget_exceeded",
      name: budget.name,
    });
  } catch (error) {
    logWarn("system.budget.stat.failed", {
      "app.budget.name": budget.name,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}
