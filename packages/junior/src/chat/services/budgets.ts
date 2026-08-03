type MaybePromise<T> = T | Promise<T>;

export type BudgetStage = "conversation_admission" | "turn";
export type BudgetOutcome = "queue" | "stop";
export type BudgetUnit = "count" | "milliseconds" | "usd";

export type BudgetContext =
  | {
      activeConversations: number;
      activeConversationsForUser?: number;
      stage: "conversation_admission";
    }
  | {
      runtimeMs: number;
      stage: "turn";
      steps: number;
    };

interface InternalBudget<Name extends string = string> {
  defaultLimit: number;
  description: string;
  envName: string;
  label: string;
  measure(context: BudgetContext): MaybePromise<number | undefined>;
  name: Name;
  outcome: BudgetOutcome;
  stage: BudgetStage;
  unit: BudgetUnit;
}

function defineBudget<const Name extends string>(
  budget: InternalBudget<Name>,
): InternalBudget<Name> {
  return budget;
}

export const internalBudgets = [
  defineBudget({
    defaultLimit: 100,
    description: "Queues additional conversations.",
    envName: "JUNIOR_MAX_ACTIVE_CONVERSATIONS",
    label: "Active globally",
    measure: (context) =>
      context.stage === "conversation_admission"
        ? context.activeConversations
        : undefined,
    name: "active_conversations_global",
    outcome: "queue",
    stage: "conversation_admission",
    unit: "count",
  }),
  defineBudget({
    defaultLimit: 5,
    description: "Applies when a stable user ID is available.",
    envName: "JUNIOR_MAX_ACTIVE_CONVERSATIONS_PER_USER",
    label: "Active per user",
    measure: (context) =>
      context.stage === "conversation_admission"
        ? context.activeConversationsForUser
        : undefined,
    name: "active_conversations_user",
    outcome: "queue",
    stage: "conversation_admission",
    unit: "count",
  }),
  defineBudget({
    defaultLimit: 21_600_000,
    description: "Cumulative active time across resumes.",
    envName: "JUNIOR_MAX_TURN_RUNTIME_MS",
    label: "Runtime per turn",
    measure: (context) =>
      context.stage === "turn" ? context.runtimeMs : undefined,
    name: "turn_runtime",
    outcome: "stop",
    stage: "turn",
    unit: "milliseconds",
  }),
  defineBudget({
    defaultLimit: 500,
    description: "Stops runaway model and tool loops.",
    envName: "JUNIOR_MAX_STEPS_PER_TURN",
    label: "Agent steps per turn",
    measure: (context) =>
      context.stage === "turn" ? context.steps : undefined,
    name: "turn_steps",
    outcome: "stop",
    stage: "turn",
    unit: "count",
  }),
] as const;

export type BudgetName = (typeof internalBudgets)[number]["name"];
export type BudgetLimits = Record<BudgetName, number>;
export type ConversationAdmissionBudgets = Pick<
  BudgetLimits,
  "active_conversations_global" | "active_conversations_user"
>;
export type TurnBudgets = Pick<BudgetLimits, "turn_runtime" | "turn_steps">;

export interface BudgetDescription {
  description: string;
  label: string;
  limit: number;
  name: BudgetName;
  outcome: BudgetOutcome;
  stage: BudgetStage;
  unit: BudgetUnit;
}

export interface BudgetExceeded {
  limit: number;
  name: BudgetName;
  outcome: "queue" | "stop";
  value: number;
}

interface BudgetLimitParser {
  (envName: string, rawValue: string | undefined): number | undefined;
}

/** Parse configured budget limits from the internal registry. */
export function readBudgetLimits(
  env: NodeJS.ProcessEnv,
  parse: BudgetLimitParser,
): BudgetLimits {
  return Object.fromEntries(
    internalBudgets.map((budget) => [
      budget.name,
      parse(budget.envName, env[budget.envName]) ?? budget.defaultLimit,
    ]),
  ) as BudgetLimits;
}

/** Return safe configured budget descriptions for reporting and UI surfaces. */
export function describeBudgets(limits: BudgetLimits): BudgetDescription[] {
  return internalBudgets.map((budget) => ({
    description: budget.description,
    label: budget.label,
    limit: limits[budget.name],
    name: budget.name,
    outcome: budget.outcome,
    stage: budget.stage,
    unit: budget.unit,
  }));
}

/** Return the first exceeded internal budget for the supplied runtime context. */
export async function checkBudgets(
  limits: Partial<BudgetLimits>,
  context: BudgetContext,
): Promise<BudgetExceeded | undefined> {
  for (const budget of internalBudgets) {
    if (budget.stage !== context.stage) {
      continue;
    }
    const limit = limits[budget.name];
    if (limit === undefined) {
      continue;
    }
    const value = await budget.measure(context);
    if (value !== undefined && value >= limit) {
      return {
        limit,
        name: budget.name,
        outcome: budget.outcome,
        value,
      };
    }
  }
  return undefined;
}

/** Terminal failure carrying the budget decision that stopped a turn. */
export class BudgetExceededError extends Error {
  constructor(readonly budget: BudgetExceeded) {
    super(
      `System budget exceeded: ${budget.name} (${budget.value}/${budget.limit})`,
    );
    this.name = "BudgetExceededError";
  }
}

/** Return whether an error carries a terminal system budget decision. */
export function isBudgetExceededError(
  error: unknown,
): error is BudgetExceededError {
  return error instanceof BudgetExceededError;
}

/** Return stable telemetry attributes for one budget decision. */
export function getBudgetAttributes(
  budget: BudgetExceeded,
): Record<string, string | number> {
  return {
    "app.budget.limit": budget.limit,
    "app.budget.name": budget.name,
    "app.budget.outcome": budget.outcome,
    "app.budget.value": budget.value,
  };
}

/** Explain a terminal turn budget with actionable recovery guidance. */
export function buildBudgetExceededResponse(eventId: string): string {
  return (
    "I couldn't finish this request because this turn reached a system budget. " +
    "Please try again with a smaller or more specific request. " +
    `Reference: \`event_id=${eventId}\`.`
  );
}
