# Background work

Junior runs each Turn in a queue worker, in slices that a time limit or a killed worker can end. Users never see a slice, but they rely on the result: each message gets exactly one reply, also when the Turn runs past its time limit or its worker dies, and the Conversation is then free for the next message. Policy: `policies/serverless-background-work.md`.

## Sub-features

- `one-reply` A user sends a message. The user gets one reply, and the next message gets its own reply.
- `host-limit` A Turn runs past its time limit. It continues in a new slice, and the user still gets one complete reply.
- `worker-killed` The worker of a running Turn dies. A new worker finishes the Turn, and the user gets one complete reply.

## How to get to it (user POV)

- Send a message from the dashboard composer, or mention Junior in Slack.
- An operator sets a short Turn time limit with `AGENT_TURN_TIMEOUT_MS` (minimum `10000`).
- A deploy or a crash kills the worker. Locally, `node $S/instance.mjs crash-worker $RUN_DIR` does that and starts a new worker.

## Driving it with browse.mjs and instance.mjs

Preconditions:

- `instance.mjs launch` (no `--mock`) started a new instance, and `instance.mjs doctor` passes. For `host-limit`, launch with `AGENT_TURN_TIMEOUT_MS=10000 node $S/instance.mjs launch`.
- `E=$RUN_DIR/evidence/background-work`.
- `R='article:has-text("junior-example")'` matches a reply from Junior in the transcript.

- **One reply (`one-reply`).** Send two messages in one Conversation. Run `node $S/browse.mjs --out $E/one-reply --timeout 300000 --goto / --fill 'role=textbox[name="Start a conversation"]=Reply with exactly: pong' --press Enter --idle --expect "$R:has-text(\"pong\")" --absent "$R >> nth=1" --snap first --fill 'role=textbox[name="Continue this conversation"]=Reply with exactly: ping' --press Enter --idle --expect "$R:has-text(\"ping\")" --absent "$R >> nth=2" --snap second`. Each message gets one reply, and the second message is not held behind the first.
- **Time limit (`host-limit`).** On the instance with `AGENT_TURN_TIMEOUT_MS=10000`, ask for work with several tool steps, as the first drive on that instance. Run `node $S/browse.mjs --out $E/host-limit --timeout 600000 --goto / --fill 'role=textbox[name="Start a conversation"]=Add five Inbox notices for me, titled Slice 1 to Slice 5. Use one separate tool call per notice, never a batch or a script. They need no answer. Then reply with exactly: DONE' --press Enter --idle --expect "$R:has-text(\"DONE\")" --absent "$R >> nth=1" --snap reply --goto /inbox --fill 'role=searchbox[name="Search review items"]=Slice' --expect 'role=list[name="Search results"] >> role=link[name=/^Slice 5/]' --absent 'role=list[name="Search results"] >> role=link >> nth=5' --snap search`. The Turn outlives several 10-second slices. One reply says `DONE`, and search finds exactly five notices, so no step ran twice.
- **Killed worker (`worker-killed`).** Start a long Turn, and kill its worker while Junior is thinking. Run `mkdir -p $E/killed; node $S/browse.mjs --out $E/killed --timeout 600000 --goto / --fill 'role=textbox[name="Start a conversation"]=Write the numbers from 1 to 300 in words, one per line, and end with the line DONE.' --press Enter --expect 'text=is thinking…' --snap thinking --idle --expect "$R:has-text(\"DONE\")" --absent "$R >> nth=1" --snap reply & node $S/instance.mjs crash-worker $RUN_DIR --when $E/killed/thinking.url.txt > $E/killed/crash.log; wait`. `crash.log` names the killed and the new worker. One reply ends with `DONE`.

## Gotchas

- A Turn can finish inside the limit, and then the drive proves nothing about `host-limit`. Check `$RUN_DIR/telemetry.ndjson` for `agent.turn.timed_out` and `conversation.work.yielded` logs of the Conversation. Without them, report the drive as not reached.
- One model call that takes longer than the time limit cannot finish in any slice. With `AGENT_TURN_TIMEOUT_MS=10000`, a prompt for one long answer restarts every 10 seconds and never replies. Use a prompt with short steps, as the recipe does.
- A killed Turn waits for its work lease to expire before a new worker takes it. Expect 2 to 3 minutes of "is thinking…".
- A kill after the reply shows but before the Turn ends tests a different window. `--when` kills as soon as `thinking.url.txt` exists, so `$E/killed` must not hold one from an earlier attempt. Note in the report whether the first reply had shown.
- `crash-worker` starts the new worker by setting a new mtime on `apps/example/server.ts`, as an edit does. It leaves no diff. Do not kill the dev server or Nitro instead: `pnpm dev` exits, and the drive proves nothing.
- `pnpm dev` logs `Local heartbeat failed: fetch failed` once at startup, before Nitro listens. It is not a failure.
- `$R >> nth=1` is the second reply. `--absent` passes when it does not exist, so run it after the `--expect` of the first reply.
