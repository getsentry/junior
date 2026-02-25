---
name: summarize-candidate
description: Summarize an engineering candidate from public GitHub activity and produce a concise hiring signal with strengths, risks, and follow-up questions.
metadata:
  owner: recruiting
  version: "0.1.0"
---

# Summarize Candidate

## When to use this skill

Use this skill when a user asks to evaluate a potential hire, interview target, or referral candidate based on public GitHub signals.

## Process

1. Identify the candidate's GitHub username or profile URL.
2. Gather contribution and repository context.
3. Produce a short hiring-oriented summary.
4. Surface uncertainty and ask for missing evidence when needed.

## Output format

Respond with these sections:

1. `Snapshot` (2-4 bullet points)
2. `Engineering strengths` (2-5 bullet points)
3. `Potential risks or gaps` (2-5 bullet points)
4. `Interview focus areas` (3-6 bullet points)
5. `Recommendation` (`strong yes`, `yes`, `mixed`, or `no`) with one-sentence rationale

Delivery guidance:

- Start with a concise 4-8 line synopsis suitable for inline chat.
- Then provide a full detailed report body suitable for a markdown attachment.
- Use plain markdown with bullets and short sections (no tables unless asked).
- Use this explicit return format so the harness attaches the report:
  `<delivery>`
  `mode: attachment`
  `attachment_prefix: candidate-summary`
  `</delivery>`
  Then include the synopsis + full report markdown body after the block.

## Guardrails

- Do not infer sensitive personal attributes.
- Avoid overconfidence from limited public data.
- If data is sparse, explicitly say so and request more sources.
- Keep the response concise and directly useful for hiring decisions.

See [candidate rubric](references/candidate-rubric.md) for scoring guidance.
