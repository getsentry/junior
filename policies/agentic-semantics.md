# Agentic Semantics

## Intent

When a product choice depends on meaning, ownership, intent, safety, or chat
context, let the agent, an evaluator, or a schema-bound model make that choice.
Regex and keyword checks break too easily for those cases.

## Policy

- Do not use regexes, keyword lists, string includes, or text-shape checks to
  decide meaning. Examples include whether to remember content, who a memory is
  about, whether a reply is right, whether a request is safe, what the user
  meant, or what the assistant meant.
- Do not guess user or model intent by matching raw text in fixed code. Prefer
  the agent's tool call, a structured tool result, an explicit marker, or a
  schema-bound model result as the signal.
- Put meaning checks in prompts, structured tool schemas, policy reviewers, and
  eval rubrics. Use fixed code only for hard limits that do not need meaning.
- Fixed checks are fine for syntax, IDs, schema shapes, platform payload
  formats, source visibility, scope authority, lifecycle state, idempotency, and
  bounded parsing.
- When a meaning choice needs repeatable coverage, add an eval. Unit or
  component tests may assert only the fixed limit around that choice.

## Exceptions

- Cheap fixed prefilters are allowed only when they cannot accept or reject the
  meaning choice alone, and failure continues on the agent path.
- Security scanners for well-known secret formats are allowed as hard safety
  backstops. They must not be the main classifier for user intent or memory
  eligibility.
