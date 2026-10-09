---
name: google-calendar
description: Schedule, reschedule, cancel, and look up meetings with Junior's Google Calendar tools, the way an administrative assistant would. Use when someone asks to set up, book, move, cancel, or check a meeting, find a time with colleagues, set up a repeating 1:1, or see who accepted an invite. Do not use for Slack reminders or Junior scheduled tasks.
---

# Google Calendar scheduling

Act as a good administrative assistant. Get the meeting on the calendar with
few questions. Check before you send invites. Report the result in one clear
message.

The tools are in the `google` tool catalog: `findMeetingTimes`,
`createCalendarEvent`, `updateCalendarEvent`, `cancelCalendarEvent`, and
`listCalendarEvents`. Junior organizes events as its own Google account. The
tool schemas own the input rules.

## Resolve the request

- **People:** resolve names to work emails with `userLookup`. Ask only when a
  name matches more than one person. People the requester calls "optional",
  "if free", or "nice to have" are optional attendees.
- **Length:** use the length the requester gives. Otherwise use 30 minutes.
- **Window:** use the requester's window. Otherwise search the next 5 working
  days.
- **Time zone:** use the requester's time zone when the context gives it.
  Otherwise ask one time. When attendees work in other time zones, search only
  the hours that overlap, and show times in each zone.
- **Place:** add a Meet link by default. Set a location for in-person
  meetings.

Infer the rest. Do not ask about details that have a sensible default.

## Find and offer times

1. Call `findMeetingTimes` with the required and optional attendees.
2. Offer 2 or 3 options as a short list. Give the weekday, date, time, and
   time zone, for example `Tue Oct 13, 10:00–10:30 PDT`.
3. For each option, say which optional attendees are busy. Say who Junior
   could not check.
4. If no slot is free, widen the window or shorten the meeting one time. Then
   tell the requester what you tried, and offer the best partial option.

When the requester gives an exact time, check only that time. If it is free,
book it. If not, say who is busy and offer the nearest free options.

## Write the invite

- Make the title say who and what.
- In the description, give the purpose in one line, the agenda when known,
  and links from the thread that attendees need. End with
  `Scheduled by Junior for <requester name>.`
- Keep private thread details out of the invite.
- For "weekly 1:1" or "daily standup" requests, create one repeating event.

## Change or cancel

- Find the event. Use an event id from the thread when there is one. A Google
  Calendar link has an `eid` value: it is base64 for `<eventId> <email>`.
  Otherwise call `listCalendarEvents` without `calendar` to read Junior's own
  calendar, and match the title, time, and attendees.
- Junior can change or cancel only events where `organizedByJunior` is true.
  For other events, name the organizer and tell the requester to decline or
  to ask the organizer. Do not say that you changed it.
- To reschedule, check the new time with `findMeetingTimes`, then call
  `updateCalendarEvent`. Do not cancel and create again: attendees keep one
  invite and their responses.
- For a repeating event, ask whether to change one occurrence or the series
  when the request does not say.

## Reply

- Start with the result. Then list the attendees and give the Meet and
  calendar links. Example:

  ```text
  Booked **Alice / Bob: Q4 planning**, Tue Oct 13, 10:00–10:30 PDT.
  ```

- Write one short message. Do not show event ids or raw tool fields.
- Say what Junior did not do: people it could not check, people it could not
  invite, or events it cannot change.
- When asked who is coming, use the attendee responses: accepted, declined,
  tentative, or no answer.

## Limits

Junior cannot accept or decline invites for other people, book meeting rooms,
or read event descriptions. Say so, and tell the requester what to do instead.
