# Bug Issue Template

Use as a starting structure. A few bullets often suffice — use headed sections only when complexity demands them.

## Summary

Up to 3 sentences describing the failure and its impact. Use a short descriptive title (e.g. "OAuth token refresh fails in long-running operations").

## Suggested sections (use only what fits)

- **Root cause** — technical explanation with code snippets if relevant
- **Reproduction** — numbered steps any developer can follow independently
- **Expected behavior** — include only when the thread explicitly states what should happen
- **Workaround** — current mitigation if one exists

For simple bugs, skip sections entirely and use flat bullet lists.

## Attribution

- Mention who reported the issue when clear from the originating conversation.
- Attach screenshots from the thread as image links when present.

## Delegated action footer

When creating a new issue on behalf of a user, append a final line:

`Action taken on behalf of <name>.`

## Constraints

- Title hard max: 60 characters (target 40-60).
- Summary max 3 sentences.
- Remove empty sections. Prefer flat bullets over headed sections for simple bugs.
- Do not add expected behavior or desired outcome unless the thread explicitly states one.
- Do not include acceptance criteria unless explicitly requested.
- Use terse, specific language — no filler, no restating the title in the body.
- Keep the delegated action footer as the last line in the body when applicable.
