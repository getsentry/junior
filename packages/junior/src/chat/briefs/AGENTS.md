# Briefs

This module owns the provider-neutral Brief shape, generator input, evidence
checks, version storage, post-Turn generation, and Markdown rendering.
`schema.ts` owns the shapes. `generate.ts` owns the caps and normalization.

## Generation

- `generateBrief` is pure. Callers supply the input, the previous Brief, the
  prompt, and a bound completion function.
- The deterministic record comes from `BriefInput`, not from the model.
- Code change and resource links come from trusted input. The model cannot
  add them. A model URL is kept only when it matches evidence, an input
  entry, or the previous Brief.
- Core never upgrades a decision kind. Attribution must match a named
  participant or `Junior`. Core drops items that contain Junior runtime
  markers.
- Core flags a merged claim without a `merged` link. It does not rewrite model
  text.
- `searchText` must not contain transcript text that the Brief left out.
- Keep the prompt in `prompt.ts` as a string. tsdown does not copy Markdown
  assets.

## Storage And Task

- `junior_conversation_briefs` is append-only. Each completed Turn owns at
  most one version. The task allocates the version under the Conversation row
  lock.
- Generation is off by default (`createApp({ briefs: { enabled: true } })`).
  It skips child Conversations and Turns that the latest Brief covers.
- A retry with the same `turnId` emits the stored `briefs/brief_updated`
  event again without a second model call.
- The task and `junior briefs run` send the same request to the default
  model.

## Privacy

- A public Brief survives transcript purge. A purge of a root that is not
  public deletes every Brief in its tree. Storage rejects an insert after
  that purge.
- Private derived content must not outlive the transcript. Readers apply the
  Conversation privacy gate before they show a private Brief.
- Do not generate a Brief from redacted or expired transcript content.
- Search returns only the latest version of public root Conversations. A
  Slack search stays in the current tenant.
- `briefInputFromSnapshot` never uses a raw Slack user id or a fallback label
  as a participant name.
