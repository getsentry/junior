#!/usr/bin/env python3
"""GoCD read-only deployment API client for Sentry.

Auth is injected by the Junior runtime at the egress proxy (a GoCD bearer token
plus a Google IAP token). This script sends no credentials itself; it just calls
the GoCD API over HTTPS and the proxy stamps the headers on the way out.

Commands: pipelines, status, history, stage, job-log, find-deploy, failures, paused
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

GOCD_HOST = os.environ.get("GOCD_HOST", "https://deploy.getsentry.net")
GOCD_PAGE_SIZE_MIN = 10


class ApiError(Exception):
    """A failed GoCD API call, carrying a JSON-serializable payload."""

    def __init__(self, payload: dict):
        super().__init__(payload.get("error", "API error"))
        self.payload = payload


def _request(path: str, accept: str | None = None) -> tuple[int, str]:
    """Issue a GET to the GoCD API. Returns (status, body_text). Raises on
    transport/connection errors only; HTTP error codes are returned."""
    req = urllib.request.Request(f"{GOCD_HOST}{path}", method="GET")
    if accept:
        req.add_header("Accept", accept)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def api_get(path: str, version: int = 1) -> dict:
    """GET a GoCD API endpoint, return parsed JSON. Raises ApiError on failure."""
    status, body = _request(path, accept=f"application/vnd.go.cd.v{version}+json")
    if status >= 400:
        raise ApiError({"error": f"HTTP {status}", "path": path, "message": body[:500]})
    return json.loads(body)


def api_get_text(path: str) -> str:
    """GET a GoCD endpoint, return raw text (for console logs). Raises ApiError on failure."""
    status, body = _request(path)
    if status >= 400:
        raise ApiError({"error": f"HTTP {status}", "path": path, "message": body[:500]})
    return body


def try_get_text(path: str) -> tuple[str | None, int | None]:
    """Best-effort text fetch. Returns (text, http_status); text is None on failure."""
    try:
        status, body = _request(path)
        return (body, status) if status < 400 else (None, status)
    except OSError:
        return None, None


_DEDUP_DIGIT_RE = re.compile(r"\d+")


def smart_dedup(lines: list[str], min_run: int = 4) -> tuple[list[str], dict]:
    """Collapse runs of >=min_run consecutive lines that differ only in digit fields.

    Replaces digit sequences with `#` to detect "same line, different counter/timestamp/host"
    patterns common in deploy logs (e.g. `Pod 1/100 ready`, `[12:34:01] migrating ...`).
    """
    if len(lines) < min_run:
        return lines, {"groups_collapsed": 0, "lines_saved": 0}

    out: list[str] = []
    groups = 0
    saved = 0
    i = 0
    while i < len(lines):
        norm = _DEDUP_DIGIT_RE.sub("#", lines[i])
        j = i + 1
        while j < len(lines) and _DEDUP_DIGIT_RE.sub("#", lines[j]) == norm:
            j += 1
        run = j - i
        if run >= min_run:
            out.append(lines[i])
            out.append(f"... [{run - 2} similar lines collapsed] ...")
            out.append(lines[j - 1])
            groups += 1
            saved += run - 3
        else:
            out.extend(lines[i:j])
        i = j
    return out, {"groups_collapsed": groups, "lines_saved": saved}


def fmt_timestamp(ms: int | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def fmt_stage(stage: dict) -> dict:
    return {
        "name": stage.get("name"),
        "counter": stage.get("counter"),
        "status": stage.get("result") or stage.get("status", "Unknown"),
        "jobs": [
            {
                "name": j.get("name"),
                "state": j.get("state"),
                "result": j.get("result"),
                "scheduled": fmt_timestamp(j.get("scheduled_date")),
            }
            for j in stage.get("jobs", [])
        ],
    }


def fmt_materials(build_cause: dict) -> list[dict]:
    out = []
    for rev in build_cause.get("material_revisions", []):
        mat = rev.get("material", {})
        mods = rev.get("modifications", [])
        latest = mods[0] if mods else {}
        out.append(
            {
                "name": mat.get("name"),
                "type": mat.get("type"),
                "revision": latest.get("revision"),
                "user": latest.get("user_name"),
                "comment": (latest.get("comment") or "")[:120],
            }
        )
    return out


def fmt_pipeline_run(run: dict) -> dict:
    return {
        "name": run.get("name"),
        "counter": run.get("counter"),
        "scheduled": fmt_timestamp(run.get("scheduled_date")),
        "materials": fmt_materials(run.get("build_cause", {})),
        "stages": [fmt_stage(s) for s in run.get("stages", [])],
    }


def fetch_dashboard() -> dict:
    """Full dashboard: every group, pipeline, pause state, and latest run in one call."""
    return api_get("/go/api/dashboard", version=4)


def dashboard_groups(dashboard: dict) -> dict[str, list[str]]:
    """Map of group name -> pipeline names from a dashboard response."""
    return {
        g.get("name"): g.get("pipelines", [])
        for g in dashboard.get("_embedded", {}).get("pipeline_groups", [])
    }


def fetch_pipeline_groups() -> dict[str, list[str]]:
    """Map of group name -> pipeline names. Uses the dashboard endpoint, which any
    viewer can read (unlike /go/api/admin/pipeline_groups)."""
    return dashboard_groups(fetch_dashboard())


def resolve_pipelines(name: str) -> list[str]:
    """If name is a group, return its pipelines. Otherwise return [name]."""
    groups = fetch_pipeline_groups()
    return groups[name] if name in groups else [name]


def cmd_pipelines(args: argparse.Namespace) -> None:
    output = [
        {"group": name, "pipelines": pipelines}
        for name, pipelines in fetch_pipeline_groups().items()
        if pipelines
    ]
    print(json.dumps(output, indent=2))


def _pipeline_status(name: str) -> dict:
    status = api_get(f"/go/api/pipelines/{name}/status")
    history = api_get(f"/go/api/pipelines/{name}/history?page_size=10")
    runs = history.get("pipelines", [])
    return {
        "pipeline": name,
        "paused": status.get("paused", False),
        "paused_cause": status.get("paused_cause"),
        "paused_by": status.get("paused_by"),
        "locked": status.get("locked", False),
        "schedulable": status.get("schedulable", True),
        "latest_run": fmt_pipeline_run(runs[0]) if runs else None,
    }


def _current_stage(latest_run: dict | None) -> dict | None:
    """Return the most informative stage: first running/failed, else last."""
    if not latest_run:
        return None
    stages = latest_run.get("stages", [])
    for s in stages:
        st = s.get("result") or s.get("status", "Unknown")
        if st in ("Building", "Failed", "Unknown"):
            return {"name": s.get("name"), "status": st}
    if stages:
        last = stages[-1]
        return {
            "name": last.get("name"),
            "status": last.get("result") or last.get("status"),
        }
    return None


def _summary_from_dashboard(entry: dict) -> dict:
    """Compact per-pipeline state from a dashboard pipeline entry; no extra API calls."""
    pause = entry.get("pause_info", {})
    instances = entry.get("_embedded", {}).get("instances", [])
    latest = max(instances, key=lambda i: i.get("counter", 0)) if instances else None
    stages = latest.get("_embedded", {}).get("stages", []) if latest else []
    building = any(s.get("status") == "Building" for s in stages)
    if pause.get("paused"):
        state = "paused"
    elif entry.get("locked") or building:
        state = "in_flight"
    else:
        state = "idle"
    return {
        "pipeline": entry.get("name"),
        "state": state,
        "counter": latest.get("counter") if latest else None,
        "stage": _current_stage({"stages": stages}) if latest else None,
        "paused_cause": pause.get("pause_reason") or None,
        "scheduled": latest.get("scheduled_at") if latest else None,
    }


def cmd_status(args: argparse.Namespace) -> None:
    if not args.detailed:
        dashboard = fetch_dashboard()
        groups = dashboard_groups(dashboard)
        if args.pipeline in groups:
            by_name = {
                p.get("name"): p
                for p in dashboard.get("_embedded", {}).get("pipelines", [])
            }
            results = [
                _summary_from_dashboard(by_name[n])
                for n in groups[args.pipeline]
                if n in by_name
            ]
            print(json.dumps({"group": args.pipeline, "pipelines": results}, indent=2))
            return
        print(json.dumps(_pipeline_status(args.pipeline), indent=2))
        return

    pipelines = resolve_pipelines(args.pipeline)
    if len(pipelines) == 1:
        print(json.dumps(_pipeline_status(pipelines[0]), indent=2))
        return

    def _fetch_one(p: str) -> dict:
        # One broken pipeline becomes an error entry, not a dead group view.
        try:
            return _pipeline_status(p)
        except ApiError as e:
            return {"pipeline": p, "error": e.payload}

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(_fetch_one, pipelines))
    print(json.dumps({"group": args.pipeline, "pipelines": results}, indent=2))


def cmd_history(args: argparse.Namespace) -> None:
    page_size = max(GOCD_PAGE_SIZE_MIN, args.count)
    data = api_get(f"/go/api/pipelines/{args.pipeline}/history?page_size={page_size}")
    runs = [fmt_pipeline_run(r) for r in data.get("pipelines", [])][: args.count]
    print(json.dumps({"pipeline": args.pipeline, "total": len(runs), "runs": runs}, indent=2))


def cmd_stage(args: argparse.Namespace) -> None:
    data = api_get(
        f"/go/api/stages/{args.pipeline}/{args.pipeline_counter}/{args.stage}/{args.stage_counter}",
        version=3,
    )
    jobs = []
    for j in data.get("jobs", []):
        transitions = {
            t["state"]: t.get("state_change_time")
            for t in j.get("job_state_transitions", [])
        }
        jobs.append(
            {
                "name": j.get("name"),
                "state": j.get("state"),
                "result": j.get("result"),
                "agent_uuid": j.get("agent_uuid"),
                "scheduled": fmt_timestamp(j.get("scheduled_date")),
                "assigned": fmt_timestamp(transitions.get("Assigned")),
                "preparing": fmt_timestamp(transitions.get("Preparing")),
                "building": fmt_timestamp(transitions.get("Building")),
                "completing": fmt_timestamp(transitions.get("Completing")),
                "completed": fmt_timestamp(transitions.get("Completed")),
            }
        )
    print(
        json.dumps(
            {
                "pipeline": data.get("pipeline_name"),
                "pipeline_counter": data.get("pipeline_counter"),
                "stage": data.get("name"),
                "stage_counter": data.get("counter"),
                "result": data.get("result"),
                "jobs": jobs,
            },
            indent=2,
        )
    )


def cmd_job_log(args: argparse.Namespace) -> None:
    path = (
        f"/go/files/{args.pipeline}/{args.pipeline_counter}"
        f"/{args.stage}/{args.stage_counter}"
        f"/{args.job}/cruise-output/console.log"
    )
    raw = api_get_text(path).splitlines()
    total = len(raw)

    if args.full:
        out_lines = raw
        dedup_summary: dict | None = None
        truncated = False
    else:
        deduped, dedup_summary = smart_dedup(raw)
        if args.tail and len(deduped) > args.tail:
            out_lines = deduped[-args.tail :]
            truncated = True
        else:
            out_lines = deduped
            truncated = False

    print(
        json.dumps(
            {
                "pipeline": args.pipeline,
                "pipeline_counter": args.pipeline_counter,
                "stage": args.stage,
                "stage_counter": args.stage_counter,
                "job": args.job,
                "total_lines": total,
                "showing_lines": len(out_lines),
                "truncated": truncated,
                "dedup": dedup_summary,
                "log": "\n".join(out_lines),
            },
            indent=2,
        )
    )


def _scan_run_for_sha(run: dict, sha_lower: str) -> tuple[str | None, str | None]:
    """Find a (revision, material_name) pair where revision matches the given SHA."""
    for rev in run.get("build_cause", {}).get("material_revisions", []):
        for mod in rev.get("modifications", []):
            revision = (mod.get("revision") or "").lower()
            if revision.startswith(sha_lower):
                return mod.get("revision"), rev.get("material", {}).get("name")
    return None, None


def cmd_find_deploy(args: argparse.Namespace) -> None:
    """Search recent pipeline runs for ones that include a given commit SHA."""
    sha_lower = args.sha.lower()
    pipelines = resolve_pipelines(args.pipeline)
    page_size = max(GOCD_PAGE_SIZE_MIN, args.count)

    def _scan(p: str) -> list[dict]:
        try:
            data = api_get(f"/go/api/pipelines/{p}/history?page_size={page_size}")
        except ApiError as e:
            return [{"pipeline": p, "error": e.payload}]
        out = []
        for run in data.get("pipelines", [])[: args.count]:
            rev, mat = _scan_run_for_sha(run, sha_lower)
            if rev is None:
                continue
            out.append(
                {
                    "pipeline": p,
                    "counter": run.get("counter"),
                    "matched_revision": rev,
                    "material": mat,
                    "scheduled": fmt_timestamp(run.get("scheduled_date")),
                    "stages": [
                        {"name": s.get("name"), "status": s.get("result") or s.get("status")}
                        for s in run.get("stages", [])
                    ],
                }
            )
        return out

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        matches = [m for batch in ex.map(_scan, pipelines) for m in batch]

    print(
        json.dumps(
            {
                "sha": args.sha,
                "matches": matches,
                "searched_pipelines": pipelines,
                "search_window": args.count,
            },
            indent=2,
        )
    )


def cmd_paused(args: argparse.Namespace) -> None:
    """List currently-paused pipelines, optionally scoped to a single group."""
    dashboard = fetch_dashboard()
    groups = dashboard_groups(dashboard)
    if args.group and args.group not in groups:
        print(
            json.dumps(
                {
                    "error": f"Group not found: {args.group}",
                    "hint": "Run `pipelines` to list available groups.",
                },
                indent=2,
            )
        )
        sys.exit(1)

    group_of = {p: g for g, ps in groups.items() for p in ps}
    checked = 0
    paused = []
    for entry in dashboard.get("_embedded", {}).get("pipelines", []):
        group = group_of.get(entry.get("name"))
        if args.group and group != args.group:
            continue
        checked += 1
        pause = entry.get("pause_info", {})
        if not pause.get("paused"):
            continue
        paused.append(
            {
                "group": group,
                "pipeline": entry.get("name"),
                "paused_cause": pause.get("pause_reason") or None,
                "paused_by": pause.get("paused_by") or None,
                "paused_at": pause.get("paused_at"),
            }
        )

    print(json.dumps({"scope": args.group or "all", "checked": checked, "paused": paused}, indent=2))


def cmd_failures(args: argparse.Namespace) -> None:
    """Find recent failed runs in a pipeline or group, with first failed job's log tail."""
    groups = fetch_pipeline_groups()
    if args.pipeline in groups:
        pipelines = groups[args.pipeline]
    else:
        all_pipelines = {p for ps in groups.values() for p in ps}
        if args.pipeline not in all_pipelines:
            print(
                json.dumps(
                    {
                        "error": f"'{args.pipeline}' is neither a pipeline group nor a pipeline.",
                        "hint": "Run `pipelines` to list available groups and pipelines.",
                    },
                    indent=2,
                )
            )
            sys.exit(1)
        pipelines = [args.pipeline]

    page_size = max(GOCD_PAGE_SIZE_MIN, args.count)

    def _scan(p: str) -> list[dict]:
        try:
            data = api_get(f"/go/api/pipelines/{p}/history?page_size={page_size}")
        except ApiError as e:
            return [{"pipeline": p, "error": e.payload}]
        out = []
        for run in data.get("pipelines", [])[: args.count]:
            for stage in run.get("stages", []):
                if stage.get("result") != "Failed":
                    continue
                failed_jobs = [
                    j.get("name") for j in stage.get("jobs", []) if j.get("result") == "Failed"
                ]
                log_excerpt = None
                log_status = "no_failed_jobs" if not failed_jobs else "fetch_failed"
                if failed_jobs:
                    log_path = (
                        f"/go/files/{p}/{run.get('counter')}"
                        f"/{stage.get('name')}/{stage.get('counter')}"
                        f"/{failed_jobs[0]}/cruise-output/console.log"
                    )
                    raw, http_status = try_get_text(log_path)
                    if raw is not None:
                        deduped, _ = smart_dedup(raw.splitlines())
                        log_excerpt = "\n".join(deduped[-50:])
                        log_status = "ok"
                    elif http_status == 404:
                        log_status = "archived"
                out.append(
                    {
                        "pipeline": p,
                        "counter": run.get("counter"),
                        "scheduled": fmt_timestamp(run.get("scheduled_date")),
                        "stage": stage.get("name"),
                        "stage_counter": stage.get("counter"),
                        "failed_jobs": failed_jobs,
                        "log_excerpt": log_excerpt,
                        "log_status": log_status,
                    }
                )
        return out

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        failures = [f for batch in ex.map(_scan, pipelines) for f in batch]

    print(
        json.dumps(
            {"pipeline_or_group": args.pipeline, "failures": failures, "search_window": args.count},
            indent=2,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="GoCD read-only deployment API client for Sentry")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("pipelines", help="List all pipeline groups and pipelines")

    p = sub.add_parser("status", help="Current status of a pipeline or group")
    p.add_argument("pipeline")
    p.add_argument(
        "--detailed",
        action="store_true",
        help="For groups, return full per-pipeline detail instead of compact summary",
    )

    p = sub.add_parser("history", help="Recent pipeline runs")
    p.add_argument("pipeline")
    p.add_argument("--count", type=int, default=5)

    p = sub.add_parser("stage", help="Stage instance details")
    p.add_argument("pipeline")
    p.add_argument("pipeline_counter")
    p.add_argument("stage")
    p.add_argument("stage_counter")

    p = sub.add_parser("job-log", help="Console log for a job (smart-deduped by default)")
    p.add_argument("pipeline")
    p.add_argument("pipeline_counter")
    p.add_argument("stage")
    p.add_argument("stage_counter")
    p.add_argument("job")
    p.add_argument("--tail", type=int, default=200, help="Lines after dedup to keep (default 200)")
    p.add_argument("--full", action="store_true", help="Return entire raw log, no dedup or tail")

    p = sub.add_parser("find-deploy", help="Find pipeline runs containing a commit SHA")
    p.add_argument("sha", help="Full or partial commit SHA")
    p.add_argument("pipeline", help="Pipeline name or group to search")
    p.add_argument("--count", type=int, default=20, help="Runs per pipeline to scan (default 20)")

    p = sub.add_parser("failures", help="Recent failed runs in a pipeline or group")
    p.add_argument("pipeline")
    p.add_argument("--count", type=int, default=10, help="Runs per pipeline to scan (default 10)")

    p = sub.add_parser("paused", help="List currently-paused pipelines")
    p.add_argument("group", nargs="?", help="Optional group to scope to; default scans all")

    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        {
            "pipelines": cmd_pipelines,
            "status": cmd_status,
            "history": cmd_history,
            "stage": cmd_stage,
            "job-log": cmd_job_log,
            "find-deploy": cmd_find_deploy,
            "failures": cmd_failures,
            "paused": cmd_paused,
        }[args.command](args)
    except ApiError as e:
        print(json.dumps(e.payload, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()
