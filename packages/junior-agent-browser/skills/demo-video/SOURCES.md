# Demo Video Sources

## Source Inventory

Reviewed 2026-09-29. Official docs and repository contracts are authoritative for syntax and ownership. The completed workflow is evidence of one working setup, not a performance guarantee.

| Source                                                                            | Confidence                 | Contribution and limits                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent Skills specification](https://agentskills.io/specification)                | High                       | Frontmatter, directory names, and relative bundled files.                                                                                                                                                |
| `packages/junior-agent-browser/plugin.yaml`, package manifest, and sibling skills | High                       | Browser ownership and packaged skill discovery. Keep runtime setup in the manifest.                                                                                                                      |
| `packages/junior-tts/skills/tts/SKILL.md`                                         | High                       | Speech workflow, fresh paths, provider ownership, and paid-request limits. Reference rather than duplicate its credential policy.                                                                        |
| `policies/agent-steering.md`                                                      | High                       | One owner per rule. No extra system prompt or core tool changes.                                                                                                                                         |
| [Remotion render CLI](https://www.remotion.dev/docs/cli/render)                   | High                       | Composition selection, codec, frame range, scale, concurrency, audio bitrate, and overwrite controls. Check flags against the installed version.                                                         |
| [Remotion performance](https://www.remotion.dev/docs/performance)                 | High                       | Concurrency tradeoffs, local assets, resolution, and expensive GPU effects. No universal fastest setting.                                                                                                |
| [Remotion versions](https://www.remotion.dev/docs/version-mismatch)               | High                       | Exact, matching Remotion package versions.                                                                                                                                                               |
| [Remotion licensing](https://www.remotion.dev/docs/license)                       | High                       | Commercial use has license conditions; no free-use assumption.                                                                                                                                           |
| Completed browser-to-Remotion presentation and user revisions, September 2026     | High for observed outcomes | Real React UI with local fixtures; measured WAV clips; Remotion 4.0.354; FFmpeg decode and frame checks; successful MP4, WAV, and source delivery. Generalized here without transcript or identity data. |

Documentation is linked and summarized, not copied as a bundled upstream manual. No third-party media, project-specific avatar, sample app data, or generated speech is included.

## Decisions And Coverage

- **Adopted:** general Junior ownership in the existing browser plugin. Browser capture is the entry point. The workflow is not specific to one app or deployment.
- **Adopted:** workflow-process class and reference-backed shape. The main checklist is short; exact rendering commands are a separate lookup. Inline-only guidance would mix story decisions with optional CLI detail.
- **Adopted:** product-led narration, requested collaborator credit, and supported capability claims. User corrections rejected voice-focused introductions and take numbers.
- **Adopted:** reuse unchanged speech and captures. Measure new clips and update later scene starts. This reduced paid generation during small edits.
- **Adopted:** inspect output after timeouts; check actual attachment bytes. One render completed despite a tool timeout. A large master needed a smaller delivery copy.
- **Adopted:** standard-library WAV measurement fallback. FFmpeg was available while FFprobe was not. No extra audio package was needed.
- **Rejected:** shipping the one-off composition, fixtures, assets, or hardcoded browser path. Those are project choices, not reusable skill policy.
- **Deferred:** a Remotion plugin, installed render dependencies, generator scripts, forced caption alignment, and phoneme-level avatar animation. No recurring need for that scope was established.

Coverage includes preconditions (brief, source, tools, license), ordered flow (capture through delivery), safety (local fixtures and no production actions), failures (auth, missing tools, timeout, size), revision examples, and verified output limits. All runtime reference files are routed directly from `SKILL.md`.

Portability: pnpm, Node, Remotion, an installed browser, and FFmpeg are explicit. TTS is optional and delegated to the installed skill. Python is only a conditional WAV fallback. No host path, provider token, or model name is required by this skill.

## Precision And Validation Notes

Added one skill because neither browser automation nor visual QA owns edited presentation production. Kept those workflows unchanged. Moved command detail and examples into one reference; provenance and trigger review stay in maintenance files. No new tool descriptions, manifests, or dependency setup rules were added.

Trigger review separates edited presentations from raw capture, visual QA, audio-only work, and operating the app. Examples cover the happy path, private-data handling, story correction, capability claims, and delivery recovery.

Collection stopped after the successful workflow, its observed failures, current official syntax, and repository registration rules covered the requested scope. Broader video tooling research would not change this small workflow.

Open limits: this instruction-only addition has structural and manual content checks, not a new model-graded execution eval. Rendering commands came from the observed workflow and official docs; future environments must check dependencies, licenses, and destination limits. No new paid narration is needed to validate this skill change.
