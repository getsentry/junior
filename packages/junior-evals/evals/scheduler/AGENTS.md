# Scheduler Evals

- This folder owns model choice for scheduled automations: what a create
  writes in the instruction, and what a due occurrence posts, to whom, and
  when it posts nothing. This includes whether a post mentions the creator.
- Hard-fail scheduler contracts (create, credential mode, reschedule,
  management, delivery threads) live in `evals/integration/scheduler/`.
  Runtime wiring, such as the creator mention in the run input, is checked in
  `packages/junior/tests/`.
- Write authorization for scheduled work lives in Guardian
  (`evals/guardian/scheduled-work.eval.ts`), not here. Keep notification
  defaults and write authorization in separate cases.
- Each automation run failure seen in production has one realistic case. Cite
  the issue (for example #2014, #554, #1741) in the case or rubric. Extend that
  case. Do not add a second case for the same failure.
- A run that cannot work ends as `misconfigured` without a post. A blocked
  event automation sends its notice only to its creator.
