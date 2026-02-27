# Capability guidance

Use capability names declared by active skill policy, for example:

- `github.issues.read`
- `github.issues.write`
- `github.issues.comment`
- `github.labels.write`

Scoping rules:

- Capability should be declared in the active skill frontmatter (`requires-capabilities`).
- Declarations are currently soft-enforced (warn-only) and will harden later.
