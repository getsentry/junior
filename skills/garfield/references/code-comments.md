# Code Comments Policy

## Intent

Comments preserve durable facts that a maintainer cannot recover reliably from code, types, names, or tests. They should not narrate implementation.

## Policy

- Comment non-obvious ownership, invariant lifetime, lock or transaction ordering, post-commit behavior, compatibility constraints, and counterintuitive tradeoffs.
- Record each fact once at the highest stable boundary that owns it. Do not repeat one lifecycle invariant in module, wrapper, and helper comments.
- Add JSDoc to an exported or private function only when its contract contains a durable fact not recoverable from its signature, name, owning module, or tests.
- Keep comments short, concrete, and current.
- Rewrite or remove stale, ambiguous, temporary-plan, and overclaiming comments touched or invalidated by the slice.

## Exceptions

- Do not comment obvious transformations or control flow.
- Do not add comments that simply restate the code in English.
- Do not require a comment solely because a module is important or a symbol is exported, private, or newly added.
- Prefer clearer names, types, or boundaries when they can make the same fact evident without prose.
