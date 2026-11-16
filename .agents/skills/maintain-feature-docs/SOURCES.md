# Sources

- pstack `maintain-verification-skill`
  (michael-denyer/pstack-claude@a12b047, a port of poteto's pstack). Taken:
  clean, changed, or blocked outcome; edit scope limited to the docs; index
  check; one read-only source subagent per feature file; spot-check before
  fix; doc drift versus product regression; one PR of proven corrections.
- Not taken: the required live pass. Junior's behavior is mostly in source,
  tests, and evals, so the live check runs only when source cannot decide.

## Decisions

1. The pass also checks each line against the contract and cuts lines that
   break it. This takes the place of a size limit.
2. Behavior IDs without an eval or test go on a coverage list. The pass does
   not write tests.
3. Daily scope checks only the files that the last day of commits affects.
   Full scope runs weekly.
