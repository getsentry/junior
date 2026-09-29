# Render And Revise A Demo

## Project Setup

Check Node.js, pnpm, FFmpeg, and an installed supported browser before rendering. Use the browser executable path found in the current Sandbox, not a saved path from another run. FFprobe is optional; it may be absent even when FFmpeg is present.

This skill ships instructions, not Remotion or FFmpeg. Do not install or repair the browser plugin runtime here. If an external dependency is unavailable or installation is not permitted, report the missing dependency. Check the organization's Remotion license before commercial use; do not assume the free license applies.

Keep a new project outside the app checkout:

```text
demo-video/
  package.json
  pnpm-lock.yaml
  src/index.tsx
  src/scenes.json
  public/
  out/
  README.md
```

For a new, authorized local artifact project, choose a verified compatible version. Replace the placeholders before running:

```bash
pnpm add --save-exact remotion@<version> @remotion/cli@<same-version> react@<version> react-dom@<same-version>
```

All Remotion packages must have the same exact version. Reuse the lockfile on revisions. Check the installed CLI help and current docs before adding version-specific flags.

Use `registerRoot` and `Composition` for the entry point. Load local media with `staticFile` and `Img`. Put each scene and its audio in a `Sequence`. Use `useCurrentFrame`, `interpolate`, or `spring` for deterministic motion. Use media components supported by the installed version.

Keep scene text, asset path, audio path, measured seconds, start frame, and duration in one scene record. Do not select clips through scattered filename conditions. Keep original screenshots; derive crops as separate assets.

## Measure Audio Before Setting Frames

When FFprobe is available:

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 public/scene.wav
```

For PCM WAV files, Python's standard library is a fallback when Python is available:

```bash
python3 - <<'PY'
import wave
with wave.open('public/scene.wav', 'rb') as clip:
    print(clip.getnframes() / clip.getframerate())
PY
```

For each scene:

```text
audioFrames = ceil(audioSeconds * fps)
sceneFrames = leadFrames + audioFrames + tailFrames
startFrame = sum(previous sceneFrames)
```

Place audio at `leadFrames` within the scene. Ensure fades do not cut off speech. Caption times use the same audio offset. Never keep an old duration after replacing a clip.

## Preview, Then Render

Run from the artifact project. Replace the entry point, composition ID, frame, and output names as needed. Use fresh output names. Add `--browser-executable="$BROWSER"` only after resolving that path.

```bash
pnpm exec remotion still src/index.tsx Demo out/layout.png --frame=60
pnpm exec remotion render src/index.tsx Demo out/sample.mp4 --frames=0-89 --codec=h264 --concurrency=2
pnpm exec remotion render src/index.tsx Demo out/demo.mp4 --codec=h264 --crf=26 --audio-bitrate=128k --concurrency=2 --overwrite=false
```

- Use local assets and simple transforms. Precompute audio levels or caption boundaries once, not per frame.
- Avoid blur, large shadows, and complex effects on a CPU-only Sandbox.
- Start at concurrency 2 if resources permit. More workers can make rendering slower or exhaust memory. Measure a short sample before increasing it.
- For a 1920 × 1080 composition, `--scale=0.6666666666666666` produces a 1280 × 720 copy. Scaling is not a file-size guarantee.
- Keep long-render logs in a file. On timeout, inspect the log and output before rerunning. A failed render does not require new narration.

## Export Checks And Size

```bash
# Inspect streams and duration. With no output, FFmpeg normally exits nonzero.
# This is a metadata probe, not a validation result.
ffmpeg -hide_banner -i out/demo.mp4

# Decode both streams completely. Check the exit code and stderr.
ffmpeg -v error -i out/demo.mp4 -f null -

# Measure audio level; this is not a listening check.
ffmpeg -hide_banner -i out/demo.mp4 -vn -af volumedetect -f null -

# Seek directly to a representative frame instead of decoding the full film per still.
ffmpeg -v error -ss 12 -i out/demo.mp4 -frames:v 1 -update 1 out/frame.png
```

Extract and inspect representative frames from all scenes and changed transitions. Keep captions outside the UI crop. Do not treat a contact sheet as proof that motion or speech timing is correct.

Check the destination's current limit and the file's byte size. Do not assume the upload limit from a previous conversation still applies. If necessary, re-encode the existing master:

```bash
ffmpeg -n -i out/demo.mp4 -vf scale=1280:720 -c:v libx264 -preset medium -crf 28 -c:a aac -b:a 96k -movflags +faststart out/demo-delivery.mp4
```

Measure the new file and check its text readability and decoding. If it still exceeds the limit, reduce resolution or bitrate while preserving usable UI text. Keep the original master. For standalone narration, join the original lossless clips with the same scene gaps; do not decode the compressed MP4 audio when source WAV files are available.

## Revision Examples

- **Product walkthrough:** “Present what we built in about 90 seconds.” Inspect the UI and shipped changes, capture four useful states, write a benefit-led script, then generate and measure scene clips. Deliver an MP4 and the agreed source archive.
- **Private app:** “Use our dashboard in a demo.” Sign-in blocks access. Use an authorized session or the real local UI with isolated, labeled synthetic fixtures. State that this is not a production-data recording. Do not copy private submissions or alter production to make the capture work.
- **Story correction:** “This is about the product, not your new voice.” Bad: regenerate everything and announce “take three.” Correct: remove voice and take references from spoken and on-screen text, replace only changed clips, recompute timing, and keep useful captures.
- **Add credit and operations:** “Name my collaborator and explain reminders.” Verify the name and capability. Add the credit and a short workflow explanation, including required confirmation. Do not send a reminder just to illustrate it.
- **Upload rejected:** a valid MP4 exceeds the attachment limit. Keep its narration and composition. Make a smaller delivery copy, check it, and resend that file rather than repeating paid generation.
