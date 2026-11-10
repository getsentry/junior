// Prototype only. The real panel sends the question to the reader's private,
// read-only Walkthrough Conversation and streams the Reply.
const answers: Record<string, string> = {
  "What if the refresh also returns a 401?":
    "Then refreshToken throws GitHubAuthError, the same error as before. send(req) runs once after the refresh, so it can't loop. github-api.ts:90–91.",
  "Can two Tasks refresh at once?":
    "Yes. Both refresh and the last save wins. GitHub keeps both tokens valid, so neither Task fails. No lock in this stack.",
  "Where is the token stored?":
    "In refresh_tokens, added by #3101. The ciphertext column is encrypted with the app key, like other user tokens.",
  "Why not use a longer-lived token?":
    "GitHub App user tokens always expire after 8 hours. The Brief says this was checked with the person who asked.",
  "Which automations are affected?":
    "Any scheduled automation whose tick lands during a rollout. The 212 Sentry events come from 31 automations. Hourly ones are hit most.",
  "Why was the deployment id in the key?":
    "It came from #2611, which stopped a stuck lock from blocking every later deploy. The 10-minute TTL now covers that case.",
  "What else calls withRunLock?":
    "Only the scheduler and Run now. rg finds no other callers. Event automations use their own idempotency key.",
  "What still references legacy_tokens?":
    "Nothing in this repo. rg finds no reads since #2870. Another service could still read it. Junior can't check that.",
};

/** Fixed answer for a prototype question. */
export function prototypeAnswer(question: string): string {
  return (
    answers[question] ??
    "Junior would answer this in your private Conversation for this Walkthrough, using the diff, the Brief, and the repo at the head commit."
  );
}
