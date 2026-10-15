# Time Motion To The Narration

Use this reference after the clips are measured. Every move must answer a spoken word. Keep one focal point on screen at a time.

## Align Words

Word times turn the script into cues for the camera, highlights, and captions. Use the narration WAV files, not the compressed export.

When Python, network access, and a package install are permitted, `faster-whisper` works on CPU. The first run downloads a model. If the install is not permitted, use sentence pauses from audio levels and say that timing is approximate.

```bash
python3 -m pip install --user faster-whisper
```

```python
# align.py: transcribe each clip with word times, then map them onto the script text.
import difflib, json, re
from faster_whisper import WhisperModel

model = WhisperModel("base.en", device="cpu", compute_type="int8")
norm = lambda w: re.sub(r"[^a-z0-9']", "", w.lower())
scenes = json.load(open("src/scenes.json"))  # [{"id", "text", "audio"}]
out = {}
for scene in scenes:
    segments, _ = model.transcribe(f"public/{scene['audio']}", word_timestamps=True,
                                   language="en", condition_on_previous_text=False)
    heard = [(w.word.strip(), w.start, w.end) for s in segments for w in s.words]
    script = scene["text"].split()
    times = [None] * len(script)
    ops = difflib.SequenceMatcher(None, [norm(w) for w in script], [norm(w[0]) for w in heard], autojunk=False)
    for tag, i1, i2, j1, j2 in ops.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                times[i1 + k] = heard[j1 + k][1:]
        elif tag == "replace":
            start, end = heard[j1][1], heard[j2 - 1][2]
            step = (end - start) / (i2 - i1)
            for k in range(i2 - i1):
                times[i1 + k] = (start + k * step, start + (k + 1) * step)
    for i, t in enumerate(times):
        times[i] = t or ((times[i - 1][1] if i else 0), (times[i - 1][1] if i else 0) + 0.2)
    out[scene["id"]] = [[w, round(a, 2), round(b, 2)] for w, (a, b) in zip(script, times)]
json.dump(out, open("src/words.json", "w"))
```

- Keep the script words, not the transcript words. The transcript can mishear a word; the caption must show the script.
- Do not pass the script as `initial_prompt`. In one run it made the model repeat sentences that were not spoken.
- Compare the transcript with the script. A large mismatch can mean a pronunciation problem. Report it; do not hide it.
- Set scene length from the last word end, not the WAV length. Clips often end with silence.

## Cue Helper

Look up a phrase and return its scene frame. Fail loudly when the phrase is missing, so a script edit cannot silently move a cue.

```tsx
export function cue(id: string, phrase: string, nth = 0): number {
  const words = sceneWords(id); // [[word, start, end], ...]
  const target = phrase.split(/\s+/).map(norm);
  let seen = 0;
  for (let i = 0; i <= words.length - target.length; i++) {
    if (target.every((t, j) => norm(words[i + j][0]) === t) && seen++ === nth) {
      return Math.round(lead(id) + words[i][1] * FPS);
    }
  }
  throw new Error(`cue not found: ${id} "${phrase}"`);
}
```

Write cues as `cue('02', 'open the screening')`, not frame numbers. A cue is the frame where the word starts. Offset small amounts (`- 6`, `+ 10`) for short motion, such as a highlight or a caption, so it arrives just before or as the word lands. For motion that takes longer, start it earlier by its duration. See the camera example below.

## Guided Camera

Show a capture inside a window. Pan and zoom it with keyframes in capture pixels.

```tsx
type CamKey = { f: number; cx: number; cy: number; w: number; d?: number };

export function camera(
  keys: CamKey[],
  f: number,
  img: [number, number],
  view: [number, number],
) {
  let { cx, cy, w } = keys[0];
  for (const k of keys.slice(1)) {
    const t = interpolate(f, [k.f, k.f + (k.d ?? 26)], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.65, 0, 0.35, 1),
    });
    cx += (k.cx - cx) * t;
    cy += (k.cy - cy) * t;
    w += (k.w - w) * t;
  }
  const s = view[0] / w;
  const fit = (v: number, vis: number, size: number) =>
    size <= vis ? size / 2 : Math.min(Math.max(v, vis / 2), size - vis / 2);
  cx = fit(cx, view[0] / s, img[0]);
  cy = fit(cy, view[1] / s, img[1]);
  return { s, x: view[0] / 2 - cx * s, y: view[1] / 2 - cy * s };
}
// Render: <Img style={{transformOrigin: '0 0', transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`}} />
```

- `f` is the frame where a move starts. `d` is its length (default 26 frames). The move ends at `f + d`. To make the camera arrive on a word, start the move one duration before the cue: `{ f: cue('02', 'open the screening') - 26, cx, cy, w }`. If you set `f` to the cue, the camera arrives `d` frames after the word.
- `w` is the visible capture width. A smaller `w` zooms in. Stay at or above about 70% of the capture width; stronger zooms blur 1× captures.
- Put frame edges between page sections. Do not cut a heading or card title through the middle.
- Return to a wider view when the narration summarizes.
- Two states of the same page (for example idle and playing) can share one camera. Cross-fade the second capture on top.

## Highlights And Cursor

Get element boxes from the live page at the capture viewport. Do not guess them from the image.

```bash
agent-browser --session cap eval "JSON.stringify([...document.querySelectorAll('button')]
  .filter(b => b.innerText.trim() === 'Open the screening')
  .map(b => { const r = b.getBoundingClientRect(); return [r.x + scrollX, r.y + scrollY, r.width, r.height].map(Math.round); }))"
```

- Map a box to the screen with the camera: `screenX = x * cam.s + cam.x`. Draw rings and the cursor in screen space so stroke width and label size stay constant during zooms.
- Show a ring when its word starts. Remove it before the next focal point. Add a short label only when the narration does not already say it.
- Move labels below or to the other side near window edges and near other rings.
- Make the cursor arrive at the target on the cue. Show a short ripple for a click. Hide the cursor when the scene stops pointing.
- Fake typing is acceptable over a real input when the narration describes filling the form. Cover the placeholder with the input's own background and font.

## Captions

- Make phrases from word times. End a phrase at `.`, `!`, `?`, or `:`, at a comma after four or more words, at a pause of 0.45 s or more, or at eight words.
- Show a phrase from its first word start until the next phrase starts. Keep it for about 0.6 s after the last phrase.
- Dim words that are not spoken yet. Mark the current word with an accent color.
- Keep captions in a fixed band below the UI window. Do not cover the focal point.

## Layout, Type, And Continuity

- Put a short title and a beat list beside the window. Add each beat on its cue and mark the current one. Beats summarize; captions carry the full words.
- Animate title words with per-word springs, a few frames apart. Keep the end state static and readable.
- Put persistent elements, such as a presenter avatar, progress bar, and transitions, above the scene sequences in one layer. Keyframe them across global frames, so they continue across cuts.
- For audio-reactive motion, precompute one energy value per frame per clip. Smooth it over three frames. Keep the amplitude small.
- Label an illustration on screen, for example a chat exchange that shows how a workflow runs. Base its content on documented behavior. Do not show real people saying things they did not say.

## Transitions

Use a short wipe that fully covers the frame at the cut. Change the scene under the cover.

```tsx
// Scene boundary b. A skewed panel moves from right to left over 2 * W frames.
const t = interpolate(f, [b - W, b + W], [0, 1], { ...clamp, easing });
const x = interpolate(t, [0, 1], [width + 160, -(panelWidth + 160)]);
```

- Check that the panel covers the full frame, including the skew, on frame `b`. Render stills at `b - 1`, `b`, and `b + 1`.
- Start the next narration a few frames after `b`. End the previous narration before `b - W`.
- Do not cross-fade two text-heavy layouts in the same place. Fade the first out, then bring the second in.

## Review Stills In Batches

`remotion still` bundles on each call. To check many frames, bundle once with the Node API:

```js
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const serveUrl = await bundle({
  entryPoint: "src/index.tsx",
  publicDir: "public",
});
const composition = await selectComposition({
  serveUrl,
  id: "Demo",
  browserExecutable,
});
for (const frame of frames) {
  await renderStill({
    composition,
    serveUrl,
    frame,
    output: `out/stills/f${frame}.png`,
    browserExecutable,
    scale: 0.5,
  });
}
```

With pnpm, import these packages from the installed dependency paths when they are not direct dependencies. Combine stills into a grid with FFmpeg `xstack` and inspect them.

Check each grid for these defects:

| Defect                                      | Fix                                                            |
| ------------------------------------------- | -------------------------------------------------------------- |
| Heading or card text cut by the window edge | Move `cy`, or widen `w`, so the edge falls between sections    |
| Two ring labels overlap                     | Put one label below or on the other side                       |
| Empty window while the narration talks      | Start the first item on an earlier cue                         |
| Overlay content scrolls into a header       | Clip the scrolling area below the header                       |
| Text overlaps during a scene change         | Fade out before the next layout comes in                       |
| A moving element covers a title             | Reduce the move, or place the element outside the title column |
| A ring or label is cut by the window        | Anchor the label to the other side, or move the camera         |

Then render the full video. A 1920 × 1080, 30 fps, 103-second composition rendered in about four minutes at concurrency 4 on a 4-vCPU Sandbox. Measure your own sample before you set concurrency.
