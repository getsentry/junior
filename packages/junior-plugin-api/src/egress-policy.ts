import { EgressPolicyDenied } from "./credentials";

/** One plugin-owned egress route that requires a specific operation. */
export interface ToolOwnedEgressRule {
  message: string;
  operation: string;
}

/** Match and enforce one plugin-owned route before credentials are issued. */
export function enforceToolOwnedEgress<
  Request extends { operation?: string },
  Rule extends ToolOwnedEgressRule,
>(input: {
  matches(rule: Rule, request: Request): boolean;
  request: Request;
  rules: readonly Rule[];
}): Rule | undefined {
  const rule = input.rules.find((candidate) =>
    input.matches(candidate, input.request),
  );
  if (!rule) return undefined;
  if (input.request.operation !== rule.operation) {
    throw new EgressPolicyDenied(rule.message);
  }
  return rule;
}
