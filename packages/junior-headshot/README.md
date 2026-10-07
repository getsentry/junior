# @sentry/junior-headshot

Replace the background of a headshot with a solid color or a bundled background image. Junior cuts out the person in the Sandbox with the `isnet-general-use` segmentation model through [`rembg`](https://github.com/danielgatis/rembg). Photos do not go to an outside service, and no API key is needed.

## Setup

```sh
pnpm add @sentry/junior @sentry/junior-headshot
```

Register the package in the app's shared plugin set:

```ts
import { defineJuniorPlugins } from "@sentry/junior";
export const plugins = defineJuniorPlugins(["@sentry/junior-headshot"]);
```

Use the same plugin set for the app and `juniorNitro`. Then rebuild the Sandbox snapshot with `junior snapshot create`. See [plugin setup](https://junior.sentry.dev/extend/) and [Sandbox snapshots](https://junior.sentry.dev/operate/sandbox-snapshots/).

## Snapshot Contents

The snapshot build installs Python 3.11 and creates a virtual environment at `~/.junior-headshot`. It installs pinned versions of `rembg`, ONNX Runtime, and their image libraries. It also downloads the 179 MB model and compiles the edge-color step once. Turns then start without a download or a compile.

One photo takes about 3 seconds and 1.1 GB of memory on 2 CPU threads. The BiRefNet models give slightly finer hair, but they use about 7 GB of memory. That is more than a default Sandbox has.

## Backgrounds

Junior uses the `purple-dots` background by default, so headshots stay consistent. It uses a solid color only when the user explicitly asks for one.

Bundled backgrounds are PNG files in `skills/headshot/assets/backgrounds/`. The file name without `.png` is the `--background` value. To add one, add the file and a row to the table in `skills/headshot/SKILL.md`. These files are published with the package.

## How It Works

1. The script applies the photo's EXIF orientation. It shrinks the photo to 2048 pixels on the longest edge if necessary.
2. The model makes a soft mask. Hair edges stay partly transparent.
3. PyMatting estimates the person's own color at those edges. This removes the old background color from the edge pixels, so it does not show as a halo.
4. The script puts the person on the new color, or on the bundled image scaled and cropped to cover the photo.

## Verify

Run the script on a local photo with a Python 3.11 virtual environment that has the same pinned packages as `plugin.yaml`:

```sh
cd skills/headshot
python scripts/replace-background.py --input photo.jpg --output /tmp/out.png --color '#1F1633'
python scripts/replace-background.py --input photo.jpg --output /tmp/out-dots.png --background purple-dots
```

The script prints JSON with `path`, `bytes`, `mimeType`, `width`, `height`, and `background`.
