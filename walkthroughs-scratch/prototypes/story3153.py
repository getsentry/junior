import json, wave
A = '#2D62D8'; R = '#C2372D'
def node(x, y, label, trunk=False, cls=""):
    s = f'<g class="{cls}"><rect class="n{" tr" if trunk else ""}" x="{x}" y="{y}" width="150" height="46" rx="8"/><text class="nt" x="{x+75}" y="{y+29}">{label}</text>'
    if trunk: s += f'<text class="sub" x="{x+75}" y="{y+64}">trunk</text>'
    return s + '</g>'
def left_edge(y1, y2, cls, label, lab_cls=None):
    # from lower node (y2 top-left side) up to upper node, curving left
    return (f'<path class="e {cls}" d="M105 {y2+23} C30 {y2} 30 {y1+46} 105 {y1+23}" marker-end="url(#a-{cls})"/>'
            + ''.join(f'<text class="el {lab_cls or cls}" x="62" y="{(y1+y2)//2+16+i*18}" style="text-anchor:start">{t}</text>' for i, t in enumerate(label)))
def right_edge(y1, y2, cls, label, lab_cls=None):
    return (f'<path class="e {cls}" d="M255 {y1+23} C330 {y1+46} 330 {y2} 255 {y2+23}" marker-end="url(#a-{cls})"/>'
            + ''.join(f'<text class="el {lab_cls or cls}" x="298" y="{(y1+y2)//2+16+i*18}" style="text-anchor:end">{t}</text>' for i, t in enumerate(label)))
def cells(items, y0=330, cls_fn=None):
    out = []
    for k, (txt, cls) in enumerate(items):
        x = 18 + (k % 6) * 55; y = y0 + (k // 6) * 38
        out.append(f'<g class="c {cls}"><rect x="{x}" y="{y}" width="48" height="30" rx="5"/><text x="{x+24}" y="{y+20}">{txt}</text></g>')
    return ''.join(out)
base_chain = [("#701", "ink"), ("#700", "ink")] + [("#701" if k % 2 == 0 else "#700", "bad") for k in range(9)]
chain_label = '<text class="lab" x="18" y="322">chain</text>'
TOP, BOT = 30, 200

s1 = (node(105, TOP, "master", True) + node(105, BOT, "java-v9")
      + left_edge(TOP, BOT, "bad", ["collection PR", "closed as merged"])
      + right_edge(TOP, BOT, "ink", ["sync PR"]))
s2 = (node(105, TOP, "master", True) + node(105, BOT, "java-v9")
      + left_edge(TOP, BOT, "ink", ["#700", "collection"]) + right_edge(TOP, BOT, "ink", ["#701", "sync"])
      + '<circle class="tok" cx="49" cy="139" r="8"/>' + chain_label + cells(base_chain)
      + '<text class="el bad" x="18" y="430" style="text-anchor:start;font-size:16px">stack of 11 · test fails</text>')
s3 = ('<g class="ghost">' + node(105, BOT, "java-v9") + left_edge(TOP, BOT, "ink", ["#700", "collection"]) + cells(base_chain) + '</g>'
      + node(105, TOP, "master", True) + right_edge(TOP, BOT, "ink", ["#701", "sync"])
      + '<circle class="tok" cx="262" cy="62" r="8"/><line class="stop" x1="276" y1="84" x2="296" y2="64"/>'
      + f'<text class="el acc" x="180" y="276">stops here: head is the trunk</text><text class="el" x="180" y="295">line 77</text>'
      + chain_label + '<rect class="empty" x="18" y="330" width="48" height="30" rx="5"/><text class="el acc" x="42" y="350">∅</text>'
      + '<line class="split" x1="12" y1="304" x2="12" y2="410"/><text class="sl" x="18" y="430" style="text-anchor:start">runs split here · no stack</text>')
s4 = ('<g class="ghost">' + cells(base_chain) + '</g>'
      + node(105, TOP, "java-v9") + node(105, BOT, "feat/a")
      + left_edge(TOP, BOT, "ink", ["#701"]) + right_edge(TOP, BOT, "ink", ["#700"])
      + '<circle class="tok" cx="49" cy="139" r="8"/>' + chain_label
      + cells([("#701", "ink"), ("#700", "ink"), ("#701", "acc")])
      + '<line class="split" x1="125" y1="304" x2="125" y2="410"/>'
      + '<text class="sl" x="18" y="430" style="text-anchor:start">already in the chain · line 130</text>')
def sq_row(y, n):
    return ''.join(f'<rect class="sq bad" x="{18+k*14}" y="{y}" width="10" height="22" rx="2"/>' for k in range(n))
def test_block(y, title):
    return (f'<text class="rl" x="18" y="{y}">{title}</text>'
            f'<text class="colh" x="18" y="{y+34}">before · 4fc0a41</text>' + sq_row(y+44, 11)
            + f'<text class="el bad" x="180" y="{y+61}" style="text-anchor:start">stack of 11 · fails</text>'
            f'<text class="colh" x="18" y="{y+104}">after · 7c74ace</text>'
            f'<text class="el acc" x="18" y="{y+130}" style="text-anchor:start">no stack · passes</text>')
s5 = test_block(40, "sync from the trunk") + '<line class="rule" x1="18" y1="205" x2="342" y2="205"/>' + test_block(250, "branches that loop")
s6 = (node(105, 20, "master", True) + node(105, 170, "java-v9") + node(105, 320, "feat/x")
      + left_edge(20, 170, "ink", ["collection", "PR"]) + right_edge(170, 320, "acc", ["new", "feature PR"]))
# right_edge goes top->bottom; feature PR goes feat/x -> java-v9 (bottom -> top): flip arrow by reversing path
s6 = s6.replace('d="M255 193 C330 216 330 320 255 343" marker-end="url(#a-acc)"', 'd="M255 343 C330 320 330 216 255 193" marker-end="url(#a-acc)"')
slides = [
 ("Merging a sync PR closed the wrong PR", s1, None, "Nobody merged the collection PR. GitHub marked it merged when the sync PR landed, because Junior had stacked them."),
 ("The walk never stops", s2, None, "Recorded run of the PR's new test at base 4fc0a41. The test calls the branches main and feat/long-lived; they stand in for master and java-v9."),
 ("Fix one: stop at the trunk", s3, "A PR from the default branch is never stacked work.", "Head commit 7c74ace: the new guard at line 77 returns no stack when the PR's head is the trunk."),
 ("Fix two: stop at a repeat", s4, None, "Head commit 7c74ace: the chain.includes check at line 130 stops the walk the second time it reaches #701."),
 ("Same tests, opposite results", s5, "The new skips need no log line.", "Both new tests, run at both commits. The old stacking test also fails now if the walk steps past the trunk."),
 ("One case left open", s6, "Stacking onto an open collection PR is fine for now.", "Not handled by this PR: a feature PR into java-v9 still stacks on the collection PR."),
]
nar = json.load(open('/vercel/sandbox/sb/narr/narration.json'))
out = []
for k, (h, svg, claim, ev) in enumerate(slides):
    key = f"3153-{k+1}"; w = wave.open(f'/vercel/sandbox/sb/site/audio-{key}.wav')
    out.append({"h": h, "svg": svg, "claim": claim, "evidence": ev, "n": nar[key], "audio": f"audio-{key}.wav", "dur": round(w.getnframes()/w.getframerate(), 2)})
json.dump({"title": "#3153 · Stop stacking sync PRs and looping base branches", "url": "https://github.com/getsentry/junior/pull/3153", "slides": out}, open('/vercel/sandbox/sb/site/story-3153.json', 'w'))
print("ok", len(out))
