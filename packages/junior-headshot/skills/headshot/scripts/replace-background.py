"""Replace the background of a headshot with a solid color or a bundled image."""

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps
from pymatting import estimate_foreground_ml
from rembg import new_session, remove

BACKGROUNDS_DIR = Path(__file__).resolve().parent.parent / "assets" / "backgrounds"
# BiRefNet models give slightly finer hair but peak near 7 GB of memory.
MODEL = "isnet-general-use"
# Keeps inference time bounded and output well under the 10 MB file-send limit.
MAX_EDGE = 2048
OUTPUT_FORMATS = {
    ".jpg": ("JPEG", "image/jpeg"),
    ".jpeg": ("JPEG", "image/jpeg"),
    ".png": ("PNG", "image/png"),
    ".webp": ("WEBP", "image/webp"),
}


def background_names():
    return sorted(path.stem for path in BACKGROUNDS_DIR.glob("*.png"))


def parse_color(value):
    digits = value.removeprefix("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", digits):
        raise argparse.ArgumentTypeError(f"expected a hex color like #1F1633, got {value!r}")
    return tuple(int(digits[index : index + 2], 16) for index in (0, 2, 4))


def parse_background(value):
    if value not in background_names():
        raise argparse.ArgumentTypeError(
            f"unknown background {value!r}; available: {', '.join(background_names())}"
        )
    return BACKGROUNDS_DIR / f"{value}.png"


def parse_output(value):
    path = Path(value)
    if path.suffix.lower() not in OUTPUT_FORMATS:
        raise argparse.ArgumentTypeError(
            f"output must end in one of: {', '.join(OUTPUT_FORMATS)}"
        )
    return path


def load_backdrop(color, background, size):
    if color is not None:
        return Image.new("RGB", size, color)
    with Image.open(background) as image:
        return ImageOps.fit(image.convert("RGB"), size, Image.Resampling.LANCZOS)


def replace_background(input_path, output_path, color=None, background=None):
    with Image.open(input_path) as source:
        photo = ImageOps.exif_transpose(source).convert("RGB")
    photo.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)

    mask = remove(photo, session=new_session(MODEL), only_mask=True)
    alpha = np.asarray(mask, dtype=np.float64)[:, :, None] / 255
    image = np.asarray(photo, dtype=np.float64) / 255
    # Edge pixels mix the person with the old background. Recover the person's
    # own color there so the old background does not show as a halo.
    foreground = estimate_foreground_ml(image, alpha[:, :, 0])
    backdrop = np.asarray(load_backdrop(color, background, photo.size), dtype=np.float64) / 255
    composite = foreground * alpha + backdrop * (1 - alpha)
    result = Image.fromarray(np.clip(composite * 255 + 0.5, 0, 255).astype(np.uint8))

    image_format, mime_type = OUTPUT_FORMATS[output_path.suffix.lower()]
    with open(output_path, "xb") as output:
        result.save(output, format=image_format)
    return {
        "path": str(output_path),
        "bytes": output_path.stat().st_size,
        "mimeType": mime_type,
        "width": result.width,
        "height": result.height,
        "background": background.stem if background else "#%02X%02X%02X" % color,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Headshot photo to edit.")
    parser.add_argument(
        "--output", required=True, type=parse_output, help="New .png, .jpg, or .webp path."
    )
    backdrop = parser.add_mutually_exclusive_group(required=True)
    backdrop.add_argument("--color", type=parse_color, help="Hex color, such as #1F1633.")
    backdrop.add_argument(
        "--background",
        type=parse_background,
        help=f"Bundled background name: {', '.join(background_names())}.",
    )
    args = parser.parse_args(argv)
    result = replace_background(args.input, args.output, args.color, args.background)
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
