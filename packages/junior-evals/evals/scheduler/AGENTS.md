# Scheduler Evals

- This folder owns behavioral quality of due-occurrence delivery: what a due
  scheduled automation posts, to whom, and when it posts nothing.
- Hard-fail scheduler contracts (create, credential mode, reschedule,
  management, delivery to the creator) live in `evals/integration/scheduler/`.
- Write authorization for scheduled work lives in Guardian
  (`evals/guardian/scheduled-work.eval.ts`), not here. Keep notification
  defaults and write authorization in separate cases.
- Each automation run failure seen in production has one realistic case. Cite
  the issue (for example #2014, #554, #1741) in the case or rubric. Extend that
  case. Do not add a second case for the same failure.
- A run that cannot work ends as `misconfigured` without a post. A blocked
  event automation sends its notice only to its creator.
