# Agentic Semantics

## Intent

Semantic product decisions should be made by the agent, an evaluator, or a
schema-constrained model adjudicator. Regex and keyword checks are brittle when
the contract depends on meaning, ownership, intent, safety, or conversational
context.

## Policy

- Do not use regexes, keyword lists, string includes, or text-shape heuristics
  to decide agentic semantics such as whether to remember content, who a
  memory is about, whether a reply is appropriate, whether a request is safe,
  what the user intended, or what the assistant intended.
- Do not infer user or LLM intent by matching raw natural-language input or
  output in deterministic code. Prefer the agent's chosen tool call, a
  structured tool result, an explicit marker token, or a schema-constrained
  adjudication result as the boundary signal.
- Put semantic expectations in prompts, structured tool schemas, policy
  adjudicators, and eval rubrics. Use deterministic code only to enforce hard
  boundaries that do not require understanding meaning.
- Deterministic checks are appropriate for syntax, IDs, schema shapes,
  platform payload formats, source visibility, scope authority, lifecycle
  state, idempotency, and bounded parsing.
- When a semantic decision needs repeatable coverage, add an eval. Unit or
  component tests may assert only the deterministic boundary around the
  semantic decision.

## Exceptions

- Cheap deterministic prefilters are allowed only when they cannot accept or
  reject the semantic decision by themselves and failure falls through to the
  agentic path.
- Security scanners for well-known secret formats are allowed when they are
  layered as hard safety backstops, not as the primary classifier for user
  intent or memory eligibility.
