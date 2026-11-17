# Composer

The composer is the message box under the transcript of a Conversation ("Continue this conversation"). A message sent while Junior is idle shows in the transcript at once. A message sent while Junior replies waits in the queue above the box, where the user can edit, delete, or steer it. `Stop` ends the running Turn. The box keeps an unsent draft, takes files, and takes a quote of a selected reply. It shows only in the Conversation view, not in the event log, and only to users who may reply. A question docked above the box is `review-desk#waiting`.

## Sub-features

- `send-inline` A message sent while no Turn runs shows in the transcript at once, not in the queue, and Junior replies to it.
- `enter-sends` Enter sends. Shift+Enter adds a line and sends nothing. `Send` is disabled while the draft is empty.
- `draft-kept` Unsent text stays in the box after the user leaves the Conversation and comes back in the same browser.
- `queue` A message sent while Junior replies waits in "Pending messages" as `Queued`. Junior reads it after the current reply.
- `queue-edit` `Edit queued message` takes the message out of the queue and puts its text back in the box.
- `queue-delete` `Delete queued message` takes the message out of the queue, and Junior never reads it.
- `steer` `Steer queued message` marks the message `Steered`. Junior reads it at its next step, not after the whole reply, and answers it.
- `stop` `Stop` ends the running Turn. Queued messages leave the queue, their text goes back in the box, and the Conversation shows `Stopped`.
- `attach` `Attach files` (or a drop or paste) adds up to 10 files of up to 250 MB each. Each shows above the text with a `Remove <name>` button, and the message sends with them.
- `send-failed` A send that fails stays in the transcript with "Could not send." and `Retry`.
- `respond-quote` Select text in a reply of Junior and choose `Respond`. The box gets the text as a Markdown quote.
- `conversation-view-only` `Open event log` hides the composer. `Back to conversation` shows it again, with the draft.
- `read-only` A user who may not reply to a private Conversation sees "Only participants can reply to a private conversation." in place of the box.

## How to get to it (user POV)

- Dashboard: open any Conversation (`/conversations/<id>`) in the Conversation view. A new Conversation from the composer on `/` opens there after its first send.
- The queue ("Pending messages") shows above the box while messages wait. Its row buttons have the names above.
- `Stop` shows beside `Send` while a Turn runs.
- `Respond` shows beside `Quick question` when the user selects text in a reply.
- `Conversation menu`, then `Open event log` or `Back to conversation`.
- The new dashboard (Settings, "Try the new dashboard") uses the same composer.

## Driving it with browse.mjs

Preconditions:

- `instance.mjs launch` (no `--mock`) started a new instance, and `instance.mjs doctor` passes. `read-only` needs a `--mock` instance instead.
- `E=$RUN_DIR/evidence/composer`, `C='role=textbox[name="Continue this conversation"]'`, `P='[aria-label="Pending messages"]'`.
- `R='article:has-text("junior-example")'` matches a reply from Junior.
- The textbox value shows in the ARIA snapshot as the `text:` line under `textbox "Continue this conversation"`. Read it with `grep -A3 'textbox "Continue' NAME.aria.yml`.

- **Send, Enter, quote, draft, view (`send-inline`, `enter-sends`, `respond-quote`, `draft-kept`, `conversation-view-only`).** Run `node $S/browse.mjs --out $E/basics --timeout 300000 --goto / --fill 'role=textbox[name="Start a conversation"]=Reply with exactly: pong' --press Enter --expect "$C" --idle --expect 'role=button[name="Send"][disabled]' --fill "$C=Reply with exactly: the build passed on every runner today" --press Shift+Enter --expect 'role=button[name="Send"][disabled=false]' --snap shift-enter --press Enter --expect 'article:has-text("Reply with exactly: the build passed")' --absent "$P >> text=the build passed" --snap sent --idle --expect "$R >> text=\"the build passed on every runner today\"" --select "$R >> p >> text=\"the build passed on every runner today\"" --click 'role=button[name="Respond"]' --snap quoted --goto / --expect 'role=textbox[name="Start a conversation"]' --back quoted --expect "$C" --snap back --click 'role=button[name="Conversation menu"]' --click 'role=menuitem[name="Open event log"]' --absent "$C" --snap event-log --click 'role=button[name="Conversation menu"]' --click 'role=menuitem[name="Back to conversation"]' --expect "$C" --snap conversation`. After Shift+Enter, `Send` is still enabled, so nothing was sent. The message shows in the transcript, not in the queue, and Junior replies. `quoted`, `back`, and `conversation` show `> the build passed on every runner today` in the box. `event-log` has no box.
- **Queue, delete, steer (`queue`, `queue-delete`, `steer`).** Run `node $S/browse.mjs --out $E/queue --timeout 240000 --goto / --fill 'role=textbox[name="Start a conversation"]=Write the numbers from 1 to 600 in words, one per line, and end with the line DONE.' --press Enter --expect 'role=button[name="Stop"]' --expect 'text=is thinking…' --fill "$C=Also reply with the word QUEUEDONE." --press Enter --expect "$P >> text=QUEUEDONE" --expect "$P >> [aria-label=\"Queued\"]" --snap queued --click "$P >> role=button[name=\"Delete queued message\"]" --absent "$P >> text=QUEUEDONE" --snap deleted --fill "$C=After you finish, add the line STEERED." --press Enter --click "$P >> role=button[name=\"Steer queued message\"]" --expect "$P >> [aria-label=\"Steered\"]" --snap steered --idle --expect "$R >> text=STEERED" --absent "$R >> text=QUEUEDONE" --snap reply`. The message waits as `Queued`. After the delete, Junior never says `QUEUEDONE`. The steered message shows `Steered`, and Junior answers it with `STEERED`.
- **Edit and stop (`queue-edit`, `stop`).** Run `node $S/browse.mjs --out $E/edit-stop --timeout 240000 --goto / --fill 'role=textbox[name="Start a conversation"]=Write the numbers from 1 to 600 in words, one per line, and end with the line DONE.' --press Enter --expect 'role=button[name="Stop"]' --expect 'text=is thinking…' --fill "$C=Also reply with the word QUEUEDONE." --press Enter --expect "$P >> [aria-label=\"Queued\"]" --click "$P >> role=button[name=\"Edit queued message\"]" --expect 'role=button[name="Send"][disabled=false]' --absent "$P >> text=QUEUEDONE" --snap edited --press Enter --expect "$P >> text=QUEUEDONE" --snap requeued --click 'role=button[name="Stop"]' --absent 'role=button[name="Stop"]' --absent "$P >> text=QUEUEDONE" --expect 'role=button[name="Send"][disabled=false]' --snap stopped --idle --absent "$R >> text=QUEUEDONE" --snap after`. `edited` and `stopped` show `Also reply with the word QUEUEDONE.` in the box. In `after`, the Conversation link in the list ends with `Stopped`.
- **Files (`attach`).** Run `printf 'The release codename is marmalade.\n' > $E/codename.txt; node $S/browse.mjs --out $E/attach --timeout 300000 --goto / --fill 'role=textbox[name="Start a conversation"]=Reply with exactly: ready' --press Enter --expect "$C" --idle --upload "role=button[name=\"Choose files\"]=$E/codename.txt" --expect 'role=button[name="Remove codename.txt"]' --snap attached --fill "$C=What is the release codename in the attached file? Reply with only the codename." --press Enter --absent 'role=button[name="Remove codename.txt"]' --idle --expect "$R >> text=/marmalade/i" --snap reply`. The file shows with `Remove codename.txt` before the send, and Junior answers `marmalade`.
- **Failed send (`send-failed`).** After the `attach` drive, while local uploads fail (see `Gotchas`), run `node $S/browse.mjs --out $E/send-failed --timeout 60000 --goto "$(cat $E/attach/attached.url.txt)" --upload "role=button[name=\"Choose files\"]=$E/codename.txt" --expect 'role=button[name="Remove codename.txt"]' --fill "$C=What is the release codename in the attached file? Reply with only the codename." --press Enter --expect 'text=Could not send.' --expect 'role=button[name="Retry"]' --snap failed`. The message stays in the transcript with "Could not send." and `Retry`.
- **Read-only (`read-only`).** On a `--mock` instance, run `node $S/browse.mjs --out $E/read-only --goto '/conversations/slack%3ADQA123%3A1770007200.000300' --expect 'text=Only participants can reply to a private conversation.' --absent "$C" --snap read-only`. The mock viewer is not a participant of this private Slack DM.

## Gotchas

- A new Conversation first shows a pending view with its own disabled box, also named "Continue this conversation". Enter there sends nothing, and the typed text moves to the real box when the page swaps. Wait for `--idle` or for `role=button[name="Stop"]` before you fill `$C`.
- A message sent before the transcript shows `is thinking…` can go to the transcript instead of the queue, and Junior reads it after the reply. Wait for `text=is thinking…` on the Conversation page before a queue step.
- A steer cannot cut into one long model call. With the 600-number prompt, `STEERED` shows as its own message after the numbers. The proof is the `Steered` row and the answer, not where the answer shows.
- The queue steps must finish before the reply does. The 600-number prompt gives about a minute. A faster model can need a longer prompt.
- Edit restores the text only after the server confirms the delete. Wait for `Send` to turn enabled before you snap or check the box.
- `Respond` shows only for a selection of at least a few words. A one-word reply, such as `pong`, shows no menu.
- Drafts live in browser storage, and each `browse.mjs` run is a new browser. Leave and come back inside one run.
- `Choose files` is a hidden file input that Playwright exposes as a button. Use it with `--upload`. `Attach files` opens the system file picker, which a headless browser cannot use.
- Local attachment storage is the compose `s3` service (`localhost:7072`). The browser uploads to it from `localhost:3000`, so the bucket needs CORS. The compose service has no CORS today, so the upload fails, the send shows "Could not send.", and `attach` cannot be proven past the file row locally. A failed send lives only in that browser tab. A new `browse.mjs` run does not show it.
- `read-only` needs a second user, which local development does not have (the viewer is always `dev@example.com`). The mock fixture is the only local path, and it proves only what the dashboard shows.
