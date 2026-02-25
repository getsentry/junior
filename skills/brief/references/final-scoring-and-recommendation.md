# Final Scoring and Recommendation

Use this reference to convert component-level evaluations into a final grade and hiring recommendation.

## Inputs required

- Component sections completed for:
  - GitHub/code evaluation
  - Collaboration evaluation
  - Technical communication evaluation
  - Public presence evaluation
  - Maintenance and operations evaluation
  - Location and hub evaluation
- Weighted rubric rules from [candidate-rubric.md](candidate-rubric.md)

## Synthesis process

1. Score each major component on a 1-5 scale (except location/hub, which is categorical).
2. Map component evidence to weighted rubric dimensions from `candidate-rubric.md`.
3. Convert weighted score to profile grade (`A-F`).
4. Apply location/hub modifier rules to recommendation when required.
5. Set final confidence (`high`, `medium`, `low`) based on evidence depth, consistency, and authenticity.

## Authenticity and sparsity guardrails

- If 2 or more major components have weakly verifiable evidence, cap confidence at `medium`.
- If evidence is sparse/stale across most components, cap recommendation at `mixed`.
- If core ownership or delivery evidence is unverified, do not output `strong yes`.

## Recommendation mapping

- `strong yes`: exceptional, verifiable evidence with low execution risk.
- `yes`: strong evidence with manageable risks.
- `mixed`: meaningful upside with unresolved risks or limited evidence.
- `no`: weak or high-risk profile from verified public evidence.

## Required output shape

- `Profile grade`: include grade and one-sentence plain-language rationale.
- `Hiring recommendation`: include category and one sentence.
- `Why this grade`: connect top positives and risks back to component evidence.
- `Confidence`: state level and unknowns.

All synthesis claims must trace back to component-level `References` sections. Do not introduce uncited claims in final recommendation.

