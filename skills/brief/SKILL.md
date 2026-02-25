---
name: brief
description: Grade engineering candidates from public technical evidence for non-technical hiring decisions. Use when asked to screen a candidate, referral, or interview target. Produce a structured brief with component scores, evidence-backed references, location and hub fit, and a hiring recommendation.
---

# Candidate Brief

## Workflow

1. Identify public technical sources first: GitHub/GitLab/Bitbucket contributions, public CV/resume, public speaking artifacts, portfolio sites, package registries, and public profile links (including X when technically relevant).
2. Identify hiring constraints before analysis, especially target hubs or preferred locations.
3. Build an evidence set targeting 5-8 technical artifacts for deep review.
   - Prioritize recent, candidate-owned repositories when available.
   - Include collaborative and solo evidence when possible.
   - Include at least one maintenance-heavy artifact when available.
   - If code artifacts are sparse, include non-code technical evidence.
4. Run each major review component using the matching references file, including authenticity checks.
5. Synthesize component results into grade, recommendation, confidence, and interview focus.

## Component References

Each major review component must be evaluated with the matching reference file:

- `GitHub/code evaluation`: [references/github-evaluation.md](references/github-evaluation.md)
- `CV and claim verification`: [references/cv-claim-verification.md](references/cv-claim-verification.md)
- `Public speaking and technical content evaluation`: [references/public-speaking-and-content-evaluation.md](references/public-speaking-and-content-evaluation.md)
- `Public presence evaluation`: [references/public-presence-evaluation.md](references/public-presence-evaluation.md)
- `Maintenance and operations evaluation`: [references/maintenance-and-operations-evaluation.md](references/maintenance-and-operations-evaluation.md)
- `Location and hub evaluation`: [references/location-and-hub-evaluation.md](references/location-and-hub-evaluation.md)
- `Final scoring and recommendation`: [references/final-scoring-and-recommendation.md](references/final-scoring-and-recommendation.md)

Use [candidate rubric](references/candidate-rubric.md) as the baseline scoring contract.

## Evidence and References Rules

- Every major component section in the final report must include a `References` subsection.
- Each `References` subsection must contain concrete artifact-level citations (repo path, PR, issue, commit, article, talk, package page, or profile field).
- Preferred evidence surfaces: GitHub contributions, CV/resume claims (with corroboration), public speaking artifacts, and technically substantive public posts.
- Prefer evidence from the last 12-24 months when available.
- If evidence is sparse, stale, or conflicting, state that explicitly and lower confidence.
- Do not make unverified claims; tie every material claim to cited evidence.
- Use public data only; do not rely on private or unverifiable claims.
- If a component cannot be evaluated from public data, mark it `insufficient public evidence` instead of guessing.

## Output format

Main output must begin with the profile grade.

After the delivery block, write two parts in this order:

1. `Brief summary` (3-5 bullets, max 8 lines total, non-technical language). This must appear before detailed sections.
2. `Detailed report` with these sections:
   - `Profile grade` (`A`, `B`, `C`, `D`, or `F`) with one-sentence plain-language rationale.
   - `Likely location and hub fit` (`in-hub`, `near-hub`, `outside-hub`, or `unknown`) with evidence and confidence.
   - `Hiring recommendation` (`strong yes`, `yes`, `mixed`, or `no`) with one sentence.
   - `Executive summary` (3-6 bullets for non-technical readers).
   - `GitHub/code evaluation` (`evidence sufficiency` + score when assessable + positives + risks + `References`).
   - `CV and claim verification` (`evidence sufficiency` + verified claims + unverified claims + `References`).
   - `Public speaking and technical content evaluation` (`evidence sufficiency` + score when assessable + positives + risks + `References`).
   - `Public presence evaluation` (`evidence sufficiency` + score when assessable + positives + risks + `References`).
   - `Maintenance and operations evaluation` (`evidence sufficiency` + score when assessable + positives + risks + `References`).
   - `Location and hub evaluation` (`in-hub`, `near-hub`, `outside-hub`, or `unknown` + confidence + `References`).
   - `Why this grade` (4-8 bullets linking strongest positives and biggest risks).
   - `Evidence reviewed` (5-8 bullets, each naming source/artifact and evidence scope).
   - `Interview focus areas` (3-6 bullets).
   - `Confidence` (`high`, `medium`, or `low`) with one sentence on unknowns.

Delivery guidance:

- Always include this block first:
  `<delivery>`
  `mode: attachment`
  `attachment_prefix: candidate-brief`
  `</delivery>`
- Never use `mode: inline`.
- The response body after the block is written as attachment content.
- Keep plain markdown with short sections and bullets.

## Guardrails

- Do not infer sensitive personal attributes.
- Do not treat stars or forks as quality signals by themselves.
- Avoid overconfidence from limited public data.
- If data is sparse, stale, narrow, or lacks code evidence, explicitly say so and request more sources.
- Do not penalize the candidate for private/internal signals that are not publicly observable.
- Infer location only from explicit public evidence. Do not guess from name, photo, ethnicity, or nationality.
- Report location at city/region level only; never provide precise address data.
- If target hubs are not provided, still complete the full brief and mark hub fit as provisional.
- Do not ask for permission to continue. Deliver the brief first, then optionally add one follow-up question for missing constraints.
- Keep language directly useful for non-technical hiring decisions.
