# Briefs

`schema.ts` owns the Brief shapes. `generate.ts` owns caps and normalization.

## Generation

- `generateBrief` is pure. Callers supply the input, previous Brief, prompt,
  and a bound completion function.
- The deterministic record comes from `BriefInput`, not from the model.
- Code change and resource links come only from trusted input. Keep a model
  URL only when it matches evidence, an input entry, or the previous Brief.
- Core never upgrades a decision kind. Attribution must match a named
  participant or `Junior`. Drop items with Junior runtime markers.
- Flag a merged claim without a `merged` link. Do not rewrite model text.
- `searchText` must not contain transcript text that the Brief left out.
- Keep the prompt in `prompt.ts` as a string. tsdown does not copy Markdown
  assets.

## Storage And Task

- `junior_conversation_briefs` is append-only. Each completed Turn owns at
  most one version, allocated under the Conversation row lock.
- Generation is off by default (`createApp({ briefs: { enabled: true } })`).
  It skips child Conversations and Turns that the latest Brief covers.
- A retry with the same `turnId` emits the stored `briefs/brief_updated`
  event again without a second model call.
- The task and `junior briefs run` send the same request to the default
  model.

## Privacy

- A public Brief survives transcript purge. A purge of a non-public root
  deletes every Brief in its tree, and storage rejects later inserts.
- Readers apply the Conversation privacy gate before they show a private
  Brief.
- Do not generate a Brief from redacted or expired transcript content.
- Search returns only the latest version of public root Conversations. Slack
  search stays in the current tenant.
- `briefInputFromSnapshot` never uses a raw Slack user id or a fallback label
  as a participant name.
