---
name: pagerduty
description: Look up PagerDuty on-call state through the read-only PagerDuty REST API. Use when users ask who is on call, who is rotating in or out, when the next on-call handoff is, what a schedule or escalation policy looks like, which team or service owns paging, or for PagerDuty incident status and timelines. Do not use it to acknowledge, resolve, reassign, or create incidents, to create schedule overrides, or for Sentry issues, Datadog telemetry, or Linear tickets.
---

# PagerDuty

Use this skill for read-only PagerDuty lookups: on-call, handoffs, schedules, escalation policies, services, teams, users, and incidents.

## Call the API

- Call `https://api.pagerduty.com` with `curl` from the sandbox.
- Do not send an `Authorization` header. Junior adds the PagerDuty credential to requests for this host.
- Send `-H 'Accept: application/vnd.pagerduty+json;version=2'`.
- Use only `GET`. The deployment key is read-only.
- Pipe responses through `jq` and keep only the fields you need.
- Lists page with `limit` (max `100`) and `offset`. Follow `more: true` only when the answer needs more rows.
- Array filters use bracket syntax, for example `schedule_ids[]=PABC123`. Pass them with `curl -G --data-urlencode`.
- Times are ISO 8601. Pass `time_zone=<IANA zone>` when the user names a zone.

## Workflow

1. Resolve the target.

- Use IDs or PagerDuty URLs from the request or the thread first. A URL such as `https://<subdomain>.pagerduty.com/schedules/PABC123` contains the ID.
- Otherwise resolve names with one search: `GET /schedules?query=<name>`, `GET /escalation_policies?query=<name>`, `GET /services?query=<name>`, `GET /teams?query=<name>`, or `GET /users?query=<name>`.
- If a search returns several plausible matches, list them and ask which one the user means.

2. Pick the most direct endpoint.

| Question                                    | Endpoint                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Who is on call now for a schedule or policy | `GET /oncalls?schedule_ids[]=<id>` or `escalation_policy_ids[]=<id>`; add `earliest=true`                  |
| Who is rotating in or out, next handoff     | `GET /schedules/<id>?since=<now>&until=<now+7d>`; read `final_schedule.rendered_schedule_entries`          |
| What is a user's on-call coverage           | `GET /oncalls?user_ids[]=<id>&since=<start>&until=<end>`                                                   |
| Who is on a schedule                        | `GET /schedules/<id>/users`                                                                                |
| What is the escalation path                 | `GET /escalation_policies/<id>`                                                                            |
| Which policy pages for a service            | `GET /services/<id>?include[]=escalation_policies`                                                         |
| Team members                                | `GET /teams/<id>/members?include[]=users`                                                                  |
| Open incidents                              | `GET /incidents?statuses[]=triggered&statuses[]=acknowledged`; filter with `service_ids[]` or `team_ids[]` |
| Incident detail, timeline, or notes         | `GET /incidents/<id>`, `GET /incidents/<id>/log_entries`, `GET /incidents/<id>/notes`                      |

3. Bound every query.

- Default "now" questions to the current time. Get it with `date -u +%Y-%m-%dT%H:%M:%SZ`.
- Default handoff questions to the next 7 days. Default incident history to the last 24 hours.
- In `/oncalls` results, `escalation_level` `1` is the primary responder. Say which level you report.

4. Report the result.

- Lead with the answer: names, levels, and shift start and end times in the user's zone when known.
- For handoffs, name who is on call now, who is next, and the handoff time.
- Link to the object with its `html_url` when the response contains one. Do not build links from partial IDs.
- Do not dump raw JSON.

## Guardrails

- This skill is read-only. Decline requests to acknowledge, resolve, reassign, snooze, or create incidents, to add notes or responders, or to create overrides. Tell the user to do it in PagerDuty.
- Share only the contact details that the question needs. Do not list phone numbers or email addresses unless the user asks for them.
- `401 Unauthorized`: report that the PagerDuty credential is missing or invalid for this Junior deployment. Do not retry.
- `403 Forbidden`: report that the PagerDuty credential cannot read the resource. Do not guess at missing permissions.
- `429 Too Many Requests`: wait briefly and retry the same request once. If it fails again, report the throttle.
