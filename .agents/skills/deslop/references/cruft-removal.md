# Cruft Removal Rules

Use this guide when code contains stale branches, dead paths, or indirection with no current value.

## What Counts as Cruft

1. Unreachable/dead functions and branches.
2. Flags/config branches no longer used by supported runtime paths.
3. Adapters/wrappers that only forward values without policy.
4. Compatibility layers kept after hard cutover.

## Safe Removal Sequence

1. Confirm the target is unused by static search and local references.
2. Verify no active contracts depend on it.
3. Delete in one focused change; avoid replacing with new fallback paths.
4. Run targeted tests and typecheck.
5. Record what was deleted and why.

## Keep vs Delete

| Situation | Action |
| --- | --- |
| Required by active public contract | Keep, but tighten and document intent |
| Needed for imminent migration window explicitly requested | Keep temporarily with explicit removal note |
| No active use and no contract dependency | Delete |

## Sources

- Fowler Remove Dead Code: https://refactoring.com/catalog/removeDeadCode.html
- Fowler Code Smell framing: https://martinfowler.com/bliki/CodeSmell.html
