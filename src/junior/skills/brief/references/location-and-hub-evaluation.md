# Location and Hub Evaluation

Use this reference to infer likely location and hub fit from explicit public data only.

## Scope

- Infer likely city/region fit from public profile fields or explicit public statements.
- Evaluate alignment with provided target hubs.

## Allowed evidence

- Profile location fields on public platforms.
- Public resume or work-history location statements.
- Explicit timezone/region statements in public bios/docs.

## Disallowed inference

- No guesses from names, photos, language, ethnicity, or nationality.
- No precise address-level reporting.

## Classification

- `in-hub`
- `near-hub`
- `outside-hub`
- `unknown`

Add confidence:

- `high`: direct location field plus corroborating signals.
- `medium`: indirect but consistent public signals.
- `low`: sparse, stale, or conflicting signals.

## Recommendation modifier

- If hub policy is strict and candidate is `outside-hub`, downgrade recommendation by one level unless relocation intent is explicit.
- If hub list is missing, do not force downgrade; mark hub fit as provisional.
- If location is `unknown`, cap overall confidence at `medium`.

## Required output shape

- `Location and hub evaluation`: include classification, confidence, and a `References` subsection.
- `References`: include every public location signal used.
- If no reliable signal exists, explicitly state `No reliable public location evidence`.

