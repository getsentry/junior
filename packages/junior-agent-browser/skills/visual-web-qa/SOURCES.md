# Sources

## Migrated Skill

- Repository: `getsentry/junior-prod`
- Path: `app/skills/visual-web-qa`
- Source revision: `9c394b193bdc25d89ab65993b2b1073512253d25`
- Source date: July 1, 2026
- Migrated: July 23, 2026
- Trust: first-party Sentry repository

## Local Adaptations

- Replaced the removed `attachFile` tool with Junior's `sendFiles` tool and current file-object input contract
- Preserved the source skill's toolbox approach and its distinction between static screenshot evidence and temporal video evidence
- Converted the legacy `SPEC.md` maintenance document into a Skillet-compatible `spec.md` behavior contract
- Aligned the behavior contract with the runtime guidance, where a purely temporal request may use video without a redundant screenshot
- Clarified the routing boundary between evidence-driven `/visual-web-qa` and general-purpose `/agent-browser`
- Kept the skill inline because the runtime decisions and examples are short enough to remain coherent in one file
- 2026-08-10: Added one runtime line so visual QA does not treat missing system Chrome or repo Playwright as a blocker; capture stays on `agent-browser`
