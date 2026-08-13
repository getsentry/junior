import { EgressPolicyDenied } from "./credentials";

/** One plugin-defined egress rule and its denial message. */
export interface EgressPolicyRule {
  denialMessage: string;
}

/** Apply the first plugin-defined rule that matches an egress request. */
export function enforceEgressPolicy<
  Request,
  Rule extends EgressPolicyRule,
>(input: {
  allows(rule: Rule, request: Request): boolean;
  matches(rule: Rule, request: Request): boolean;
  request: Request;
  rules: readonly Rule[];
}): Rule | undefined {
  const rule = input.rules.find((candidate) =>
    input.matches(candidate, input.request),
  );
  if (!rule) return undefined;
  if (!input.allows(rule, input.request)) {
    throw new EgressPolicyDenied(rule.denialMessage);
  }
  return rule;
}
