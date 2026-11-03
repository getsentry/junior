#!/usr/bin/env python3
"""Print a TLC counterexample from a check log, one line per step.

Each line has the step number, the action and the fields that it changed.
Usage: python3 trace.py .out/<instance>.<property>.log
"""
import re
import sys

# Budgets: they change on every fault and add noise.
SKIP = {"crashes", "expiries", "flips", "lossBudget", "postFailBudget", "sendRetries"}
TOKEN = re.compile(r'\s*(<<|>>|\|->|:>|@@|"(?:[^"\\]|\\.)*"|-?\d+|[A-Za-z_]\w*|[\[\](){},])')


def tokens(text):
    pos, out = 0, []
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m:
            if text[pos:].strip() == "":
                break
            raise ValueError(f"cannot parse at: {text[pos:pos + 40]!r}")
        out.append(m.group(1))
        pos = m.end()
    return out


def parse(toks, i=0):
    """Parse one TLA+ value printed by TLC. Return (value, next index)."""
    t = toks[i]
    if t == "[":  # record
        rec, i = {}, i + 1
        while toks[i] != "]":
            key, i = toks[i], i + 2  # skip |->
            rec[key], i = parse(toks, i)
            i += toks[i] == ","
        return rec, i + 1
    if t in ("<<", "{"):  # tuple or set
        end, items, i = (">>" if t == "<<" else "}"), [], i + 1
        while toks[i] != end:
            item, i = parse(toks, i)
            items.append(item)
            i += toks[i] == ","
        return items, i + 1
    if t == "(":  # function: (k :> v @@ k :> v)
        fn, i = {}, i + 1
        while toks[i] != ")":
            key, i = parse(toks, i)
            fn[str(key)], i = parse(toks, i + 1)
            i += toks[i] == "@@"
        return fn, i + 1
    if t.startswith('"'):
        return t[1:-1], i + 1
    if re.fullmatch(r"-?\d+", t):
        return int(t), i + 1
    return {"TRUE": True, "FALSE": False}.get(t, t), i + 1


def flat(value, prefix=""):
    if isinstance(value, list) and any(isinstance(v, (dict, list)) for v in value):
        value = {str(i + 1): v for i, v in enumerate(value)}
    if isinstance(value, dict):
        out = {}
        for key, inner in value.items():
            out.update(flat(inner, f"{prefix}.{key}" if prefix else key))
        return out
    return {prefix: str(value)}


def states(log):
    """Yield (step, action, {variable: value}) for each state of the trace."""
    for block in re.split(r"\nState (?=\d+: )", log)[1:]:
        head, _, body = block.partition("\n")
        step, action = head.split(": ", 1)
        action = re.sub(r"\s+line \d+.*", "", action).strip("<>")
        body = body.split("\n\n")[0]
        variables = {}
        for part in re.split(r"^/\\ ", body, flags=re.M):
            if " = " in part:
                name, text = part.split(" = ", 1)
                variables[name.strip()] = parse(tokens(text))[0]
        yield int(step), action, variables


def main(path):
    prev = None
    for step, action, variables in states(open(path).read()):
        now = flat(variables)
        changed = [
            f"{k}={v}"
            for k, v in now.items()
            if prev is not None and prev.get(k) != v and not SKIP & set(k.split("."))
        ]
        print(f"{step:>3} {action:<26} {'; '.join(changed)}")
        prev = now


if __name__ == "__main__":
    main(sys.argv[1])
