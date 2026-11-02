# Scheduled automations

- Keep `scheduler` as the dispatch label. It is also the signed task
  credential binding label, so a change breaks existing task credentials.
- Do not put the timezone on the Actor. The Actor is stored with each
  Message, and a timezone is a preference that can change.
- Do not emulate a Destination move with create and delete. A move keeps the
  Automation id, Schedule, creator, credential mode, and next run.
