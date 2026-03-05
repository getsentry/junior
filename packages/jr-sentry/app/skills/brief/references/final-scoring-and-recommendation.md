# Final Scoring and Recommendation

Use this reference to convert component-level evaluations into a final grade and hiring recommendation.

## Inputs required

- Component sections completed for:
  - GitHub/code evaluation
  - CV and claim verification
  - Public speaking and technical content evaluation
  - Public presence evaluation
  - Maintenance and operations evaluation
  - Location and hub evaluation
- Weighted rubric rules from [candidate-rubric.md](candidate-rubric.md)

## Synthesis process

1. Set `evidence sufficiency` for each component (`assessed`, `limited`, `not-assessed`).
2. Score each assessable major component on a 1-5 scale (except location/hub, which is categorical).
3. For CV verification, score based on verified-vs-unverified key claims.
4. Compute weighted score from assessed/limited components only and normalize to 100.
5. Convert weighted score to profile grade (`A-F`).
6. Apply location/hub modifier rules to recommendation when required.
7. Set final confidence (`high`, `medium`, `low`) based on evidence depth, consistency, and corroboration.

## Authenticity and sparsity guardrails

- If less than 60% of weighted dimensions are assessable, cap recommendation at `mixed`.
- If GitHub/code evaluation is `not-assessed`, cap recommendation at `mixed`.
- If key CV claims are unverified, do not output `strong yes`.
- Personal references/endorsements cannot be primary evidence for recommendations.

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
