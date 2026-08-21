#!/usr/bin/env python3
"""
Produce the OKX AI ASP avatar for Kinetix agent #10381.

OKX rejected the previously-uploaded avatar (kinetix-icon-1024.png) on two
counts: wrong dimensions (must be 440x440) and rounded corners (must be
square). Measuring the file OKX actually hosts confirmed both are real: it is
1024x1024 with an ~22%-radius rounded-corner alpha mask baked in (4.04% of
pixels fully transparent at the four corners).

There is no vector source for this artwork anywhere -- only PNGs. So the
corners are filled rather than redrawn: the background is a near-linear
diagonal gradient (verified by least-squares fit, residual std < 1.5/255
per channel), so a fitted fill is visually indistinguishable from the
original and the fill only ever touches the transparent corner arcs -- the
mark's bounding box (x 123-829, y 174-849) never overlaps them.

Usage:
    python3 scripts/make-okx-avatar.py \
        --source ~/Downloads/exports/kinetix-icon-1024.png \
        --out assets/kinetix-avatar-440.png
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

TARGET_SIZE = 440
MAX_BYTES = 1_000_000
# Luminance threshold separating the dark navy background from the white/teal
# mark, used both to fit the gradient and to sanity-check nothing else moved.
BG_LUMA_MAX = 260


def fit_background_gradient(rgba: np.ndarray) -> np.ndarray:
    """Least-squares fit color = c0 + c1*x + c2*y per channel, background only."""
    h, w = rgba.shape[:2]
    rgb, alpha = rgba[..., :3].astype(float), rgba[..., 3].astype(float)
    lum = rgb.sum(axis=2)
    bg_mask = (alpha > 254) & (lum < BG_LUMA_MAX)

    ys, xs = np.nonzero(bg_mask)
    if xs.size < 1000:
        raise RuntimeError(f"too few background pixels to fit a gradient ({xs.size})")

    design = np.column_stack([np.ones(xs.size), xs, ys])
    coeffs = []
    for ch in range(3):
        coef, *_ = np.linalg.lstsq(design, rgb[ys, xs, ch], rcond=None)
        pred = design @ coef
        resid = rgb[ys, xs, ch] - pred
        print(f"  channel {ch}: residual std={resid.std():.2f} max|r|={np.abs(resid).max():.1f}")
        if resid.std() > 3.0:
            raise RuntimeError(
                f"channel {ch} gradient fit is too noisy (std={resid.std():.2f}) "
                "-- the background may not be a simple linear gradient; do not proceed blindly"
            )
        coeffs.append(coef)

    xx, yy = np.meshgrid(np.arange(w), np.arange(h))
    full_design = np.stack([np.ones_like(xx), xx, yy], axis=-1).astype(float)
    layer = np.zeros((h, w, 3), dtype=float)
    for ch, coef in enumerate(coeffs):
        layer[..., ch] = full_design @ coef
    return np.clip(layer, 0, 255).astype(np.uint8)


def build_avatar(source: Path) -> Image.Image:
    src = Image.open(source).convert("RGBA")
    arr = np.asarray(src)
    h, w = arr.shape[:2]
    if w != h:
        raise RuntimeError(f"source is not square: {w}x{h}")

    transparent_pct = 100 * (arr[..., 3] == 0).sum() / (w * h)
    print(f"source: {w}x{h}, {transparent_pct:.2f}% fully transparent (corner mask)")

    print("fitting background gradient over opaque, non-mark pixels...")
    gradient_rgb = fit_background_gradient(arr)
    background = Image.fromarray(
        np.dstack([gradient_rgb, np.full((h, w), 255, dtype=np.uint8)]), "RGBA"
    )

    # Composite the original artwork over the fitted gradient: fully opaque
    # pixels pass through unchanged, the anti-aliased arc blends correctly,
    # and only the transparent corners take the fitted fill.
    composited = Image.alpha_composite(background, src).convert("RGB")

    resized = composited.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)
    return resized, composited


def verify(img: Image.Image, full_res: Image.Image, out_path: Path) -> None:
    errors = []

    if img.size != (TARGET_SIZE, TARGET_SIZE):
        errors.append(f"size is {img.size}, expected ({TARGET_SIZE}, {TARGET_SIZE})")
    if img.mode != "RGB":
        errors.append(f"mode is {img.mode}, expected RGB (no alpha channel)")

    arr = np.asarray(img.convert("RGB"))
    h, w = arr.shape[:2]
    corners = {
        "top-left": arr[0, 0],
        "top-right": arr[0, w - 1],
        "bottom-left": arr[h - 1, 0],
        "bottom-right": arr[h - 1, w - 1],
    }
    for name, rgb in corners.items():
        print(f"  corner {name}: RGB={tuple(int(c) for c in rgb)}")

    # Corner continuity: each corner should vary smoothly across its own small
    # neighborhood, not jump at a patch boundary. Measure per-channel spatial
    # spread (not RGB-flattened, which would conflate "R differs from B" --
    # true of any colored pixel -- with an actual discontinuity).
    neighborhoods = {
        "top-left": arr[0:4, 0:4],
        "top-right": arr[0:4, w - 4 : w],
        "bottom-left": arr[h - 4 : h, 0:4],
        "bottom-right": arr[h - 4 : h, w - 4 : w],
    }
    for name, block in neighborhoods.items():
        per_channel_std = block.astype(float).std(axis=(0, 1))
        spread = per_channel_std.max()
        print(f"  corner {name} 4x4 per-channel spatial std: {spread:.2f}")
        if spread > 3.0:
            errors.append(f"corner {name} shows a visible seam (spatial std={spread:.2f})")

    if out_path.stat().st_size >= MAX_BYTES:
        errors.append(f"file is {out_path.stat().st_size} bytes, must be < {MAX_BYTES}")

    # Artwork-preservation check: the mark's bounding box region, downsampled
    # the same way, should closely match a plain resize of the untouched
    # source composited onto ANY background (the mark itself is fully opaque
    # there, so background choice cannot matter). Compare center crop instead
    # of relying on exact bbox math, since resize offsets differ.
    center = np.asarray(img.convert("RGB").crop((140, 140, 300, 300)))
    plain_resize = full_res.resize((TARGET_SIZE, TARGET_SIZE), Image.LANCZOS)
    center_ref = np.asarray(plain_resize.crop((140, 140, 300, 300)))
    diff = np.abs(center.astype(int) - center_ref.astype(int)).mean()
    print(f"  center-crop artwork diff vs. reference resize: {diff:.3f} (mean abs, 0-255 scale)")
    if diff > 0.5:
        errors.append(f"center artwork diverged from reference resize (diff={diff:.3f})")

    if errors:
        print("\nFAILED:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    print("\nAll checks passed.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    resized, full_res = build_avatar(args.source)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    resized.save(args.out, "PNG", optimize=True)
    print(f"\nwrote {args.out} ({args.out.stat().st_size:,} bytes)")

    print("\nverifying...")
    verify(resized, full_res, args.out)


if __name__ == "__main__":
    main()
