/** Spike-only Preview entry for getsentry/junior#3776. Do not merge. */
import { withVersionsListenSpike } from "./spike-versions-listen.ts";

export default withVersionsListenSpike({
  fetch: () => new Response("Not found", { status: 404 }),
});
