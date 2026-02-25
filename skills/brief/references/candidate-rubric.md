# Candidate Rubric

Use this rubric to turn public technical evidence into a profile grade and hiring recommendation that non-technical stakeholders can trust.

## Review depth requirements

- Review 5-8 technical artifacts before final grading.
- Include both candidate-owned and collaborative project evidence when available.
- Require at least 12 concrete evidence points for `high` confidence.
- Capture at least 2 location/hub evidence points when available.

## Scoring dimensions

Score each dimension on a 1-5 scale, then apply weighting:

- Code quality and architecture: 25%
- Testing and reliability discipline: 20%
- Ownership and delivery follow-through: 20%
- Maintenance and operational maturity: 15%
- Collaboration and communication quality: 10%
- Scope and complexity handling: 10%

Convert the weighted score to a 0-100 profile score.

## Location and hub alignment

- Infer likely location only from explicit public signals.
- Preferred evidence includes:
  - profile or resume location fields
  - employer/location statements from public profiles
  - explicit time-zone or region declarations in public bios/docs
- Classify as:
  - `in-hub`
  - `near-hub`
  - `outside-hub`
  - `unknown`
- Add location confidence:
  - `high`: direct profile location plus supporting signals
  - `medium`: indirect but consistent signals
  - `low`: sparse or conflicting signals

Use location/hub alignment as a recommendation modifier:

- If hub policy is strict and candidate is `outside-hub`, downgrade recommendation by one level unless relocation intent is explicit.
- If hub list is missing, do not force a downgrade; mark hub fit as provisional.
- If location is `unknown`, cap confidence at `medium` and request clarification.

## Grade mapping

- `A` (90-100): exceptional profile, usually `strong yes`
- `B` (80-89): strong profile, usually `yes`
- `C` (70-79): mixed profile, usually `mixed`
- `D` (60-69): weak profile, usually `no`
- `F` (0-59): high risk profile, `no`

## Positive signals

- Clear architecture boundaries and readable module structure.
- Tests cover critical paths and CI validates changes.
- Good docs for setup, architecture, and operational workflows.
- Healthy maintenance cadence (dependency hygiene, release notes, follow-up fixes).
- Constructive PR/review behavior and thoughtful issue triage.
- Evident ownership over non-trivial scope (design plus execution).

## Negative signals

- Large complexity with no tests or quality gates.
- Stale dependencies, broken CI, or repeated build failures left unresolved.
- Minimal docs that block onboarding or operational confidence.
- Generated/copied code with little evidence of understanding.
- Abandoned repositories without follow-through on defects.
- Poor collaboration signals (dismissive reviews, unresolved blocking threads).

## Confidence scoring

- `high`: consistent evidence across multiple artifacts and collaboration surfaces.
- `medium`: mixed signals or good depth in only one or two artifacts.
- `low`: sparse, stale, or ambiguous public evidence.

## Evidence style

- Prefer concrete evidence over generic claims.
- For each major signal, include source and artifact proof (file path, PR, issue, commit, article, talk, package, or public profile field).
- For location and hub fit, include the explicit public signal used for inference.
- Translate technical evidence into plain-language impact (delivery speed, defect risk, maintainability).
