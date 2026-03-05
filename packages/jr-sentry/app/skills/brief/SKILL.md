---
name: brief
description: Grade engineering candidates from public technical evidence for non-technical hiring decisions. Use when asked to screen a candidate, referral, or interview target. Produce a structured brief with component scores, evidence-backed references, location and hub fit, and a hiring recommendation.
---

# Candidate Brief

## Workflow

1. Identify public technical sources first: GitHub/GitLab/Bitbucket contributions, public CV/resume, public speaking artifacts, portfolio sites, package registries, and non-LinkedIn public profile links (including X when technically relevant).
   - Do not spend workflow time on `linkedin.com` or LinkedIn profile caches/mirrors. Treat LinkedIn scraping/cached profile recovery as unreliable and out of scope for this skill.
   - Use alternate CV evidence sources first: personal sites/resumes, GitHub profile metadata, employer/team bios, conference speaker pages, technical articles, and package maintainer pages.
2. Identify hiring constraints before analysis, especially target hubs or preferred locations.
3. Build an evidence set targeting 5-8 technical artifacts for deep review.
   - Prioritize recent, candidate-owned repositories when available.
   - Include collaborative and solo evidence when possible.
   - Include at least one maintenance-heavy artifact when available.
   - If code artifacts are sparse, include non-code technical evidence.
   - Use artifact-level evidence (repo/file/PR/issue/commit/talk/page) instead of platform-level summaries.
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
- Avoid `linkedin.com` and scraped LinkedIn mirrors as primary evidence surfaces; use independently accessible public artifacts instead.
- Prefer evidence from the last 12-24 months when available.
- If evidence is sparse, stale, or conflicting, state that explicitly and lower confidence.
- Do not make unverified claims; tie every material claim to cited evidence.
- Use public data only; do not rely on private or unverifiable claims.
- If a component cannot be evaluated from public data, mark it `insufficient public evidence` instead of guessing.
- Treat personal references/endorsements as low-weight and never as primary evidence.

## Output format

Main output must begin with the profile grade.

Rendering constraints (strict):

- Use only headings and bullets.
- Never use markdown tables.
- Never use horizontal rules (`---`) between sections.
- Never use emoji-prefixed section headers.
- Never collapse key/value data onto one dense line. Use one bullet per field: `- Field: value`.
- Keep the opening section clean and readable.

Write two parts in this order:

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

Depth minimums:

- `GitHub/code evaluation`: cite at least 3 artifact-level references when available, including one file-level code read and one test/CI signal.
- `Maintenance and operations evaluation`: cite at least 2 artifact-level references when available.
- `CV and claim verification`: assess at least 5 high-impact claims when available.
- `Public speaking and technical content` plus `Public presence`: cite at least 2 independent artifacts combined when available.
- If a minimum cannot be met, explicitly mark `limited` or `not-assessed` and lower confidence.

Completion gate (must pass before final answer):

- Do not finalize until every required `Detailed report` section is present.
- Do not finalize until each evaluated component includes a `References` subsection.
- Do not finalize if depth minimums are missed without an explicit `limited`/`not-assessed` note and confidence downgrade.
- If evidence quality is too weak to grade reliably, still deliver the full structure and clearly mark insufficiency.

Artifact and delivery guidance:

- Treat the full brief as a document deliverable, not an inline-only chat reply.
- Use the environment's document primitives to deliver the full brief artifact (for example canvas/file/document tools when available).
- For each new `/brief <candidate>` request, create a new artifact rather than updating the prior thread canvas by default.
- Use canvas update only when the user explicitly asks to revise an existing brief and the target canvas is unambiguous.
- When updating, pass explicit `canvas_id`; do not rely on implicit thread fallback.
- Post a short TL;DR in-thread that links or points to the full artifact.
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
