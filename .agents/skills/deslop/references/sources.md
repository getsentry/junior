# Source Notes

This skill distills rules from the following sources.

## Primary Prior Art

1. Local Sentry Skills `code-simplifier` skill:
   - `/home/dcramer/src/sentry-skills/plugins/sentry-skills/skills/code-simplifier/SKILL.md`
2. Local Sentry Skills `code-simplifier` agent:
   - `/home/dcramer/src/sentry-skills/plugins/sentry-skills/agents/code-simplifier.md`

## External References

1. Go Code Review Comments: https://go.dev/wiki/CodeReviewComments
2. Google Go Style Guide (doc/comments): https://google.github.io/styleguide/go/guide#doc-comments
3. PEP 8 comments guidance: https://peps.python.org/pep-0008/#comments
4. Fowler Remove Dead Code: https://refactoring.com/catalog/removeDeadCode.html
5. Fowler Code Smell: https://martinfowler.com/bliki/CodeSmell.html
6. Nielsen Norman Group heuristics (minimalism framing): https://www.nngroup.com/articles/ten-usability-heuristics/

## Distillation Approach

1. Keep guidance enforceable and code-focused.
2. Convert broad principles into concrete guardrails and checklists.
3. Bias toward deleting complexity over moving complexity around.
