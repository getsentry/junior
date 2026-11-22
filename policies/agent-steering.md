# Agent Steering

## Intent

Agent behavior needs clear steering. Extra natural-language lines in system
prompts, tool descriptions, and skills raise cost and noise when they repeat the
same rule. Prefer one owner for each rule, and prefer structure over stacked
prose.

## Policy

- Prefer structured tool contracts, schemas, runtime gates, and code invariants
  over additive natural-language prompt lines.
- Generate deterministic output, such as links, IDs, and formats, in code from
  data the system already has. Do not fix it with prompt or tool text: the
  model does not follow text every time.
- Give each steering rule one home. Prefer the tool schema or description when
  the rule is about when or how to call that tool. Prefer the system prompt only
  for cross-tool delivery or protocol rules. Prefer a skill only for workflow
  that loads on demand.
- Do not restate the same rule in the system prompt and a tool description
  unless the second copy serves a different audience, such as the model versus a
  guardian or a human reviewer.
- When an eval flakes or fails, fix the product invariant, fixture, harness, or
  case shape first. Do not stack prompt or tool text only to force the case
  green.
- Keep prompts short. When behavior moves into code, schemas, or runtime gates,
  delete the obsolete natural-language steering in the same change.

### Writing steering text

- Write each rule as a plain instruction. Give the reason when it is not
  obvious, so the model can apply the rule to new cases.
- Do not use capitals, "IMPORTANT", or "NEVER" for emphasis. Keep them for a
  hard limit whose break fails the task or breaks safety.
- Use numbers for length, count, and time, such as "1–3 sentences". Do not
  use words such as "concise" or "brief" alone.
- To stop an output habit, quote the output to avoid. Then check replies for
  copied instruction text: models can repeat a rule word for word.
- When you add a restraint, such as "do not widen scope", check the opposite
  failure, such as stopping early, in the same evals.
- Name only tools, fields, and modes that exist where the text shows.

## Exceptions

- A short cross-reference is fine when one surface must point readers to the
  owning rule without repeating it.
- Security, privacy, and hard safety backstops may appear in more than one
  surface when each copy is required for a different enforcement path.

## Sources

Checked 2026-11-22. Research canvases: "Claude Code: tool design and prompt
design" and "Codex: tool design and prompt design".

- Claude Code 2.1.330: the main prompt uses "IMPORTANT" twice and plain "Don't"
  or "Do not" 27 times. Capitals stay for hard limits, such as no tool calls
  in compaction. Rules give reasons ("since those belong in the PR description
  and rot"). Restraint sits next to anti-stall rules ("If it is a plan... do
  that work now"). Bash routing text names only the tools that are on.
- Codex `openai/codex@ba1c17f9`: most model prompts use no "IMPORTANT".
  Length rules are numbers ("8–12 words for quick updates", "4–6 bullets").
  Commit 4ae45a6c8 removed "Bold the keyword" because the model wrote it into
  lists.
