# Sources

- pstack `create-verification-skill` and its `references/feature-map-example/`
  (michael-denyer/pstack-claude@a12b047, a port of poteto's pstack). Taken:
  one file per feature from the user's point of view, a fixed set of H2s in
  the index README, one line per sub-feature ID, and an allowlist that keeps
  implementation out. Left out: harness, launch, drive, and evidence
  sections. These docs state intent; they do not prove it.
- `policies/documentation.md`: ASD-STE100 English, say a rule once, no
  history.

## Decisions

1. `features/README.md` owns the contract, so both skills point to it and do
   not copy it.
2. No size limit or CI check. The fixed H2s, the one-line rule, and the line
   test keep files small. A size check would only measure a proxy.
