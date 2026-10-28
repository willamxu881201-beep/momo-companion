"""Cut characters out for the design mockups.

For each image: soft mask from isnet-general-use, alpha levels so the body is fully
opaque, then colour decontamination so edge pixels lose the pastel background tint
(otherwise a light halo shows on darker scenes). Writes RGBA WebP.

Usage: python cut_stills.py <out_dir> <max_height> <images...>
"""
import os, sys, time
import numpy as np
from PIL import Image
from rembg import new_session, remove

out_dir, max_h, paths = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
os.makedirs(out_dir, exist_ok=True)
session = new_session('isnet-general-use')


def _box(arr, r, axis):
    # Mean over a window of 2r+1 along one axis, edges padded, via cumulative sums.
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (r + 1, r)
    cs = np.cumsum(np.pad(arr, pad, mode='edge'), axis=axis, dtype=np.float64)
    n = cs.shape[axis]
    return (np.take(cs, np.arange(2 * r + 1, n), axis=axis) - np.take(cs, np.arange(0, n - 2 * r - 1), axis=axis)) / (2 * r + 1)


def blur(arr, radius):
    # Three box passes approximate a Gaussian; works on HxW or HxWx3 float arrays.
    r = max(1, round(radius * 0.6))
    out = arr.astype(np.float64)
    for _ in range(3):
        out = _box(_box(out, r, 0), r, 1)
    return out


for p in paths:
    t = time.time()
    rgb = Image.open(p).convert('RGB')
    mask = remove(rgb, session=session, only_mask=True, post_process_mask=False)
    c = np.asarray(rgb, dtype=np.float32) / 255.0
    a = np.asarray(mask, dtype=np.float32) / 255.0
    a = np.clip((a - 0.04) / (0.90 - 0.04), 0.0, 1.0)
    # Background colour behind each pixel, from a normalised blur of the background-only pixels.
    w = (1.0 - a) ** 4
    bg = blur(c * w[..., None], 18) / np.maximum(blur(w, 18), 1e-4)[..., None]
    f = np.where(a[..., None] > 0.03, (c - (1.0 - a[..., None]) * bg) / np.maximum(a[..., None], 0.03), c)
    f = np.clip(f, 0.0, 1.0)
    out = Image.fromarray(np.dstack([f, a]).__mul__(255).round().astype(np.uint8), 'RGBA')
    bbox = out.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    if out.height > max_h:
        out = out.resize((round(out.width * max_h / out.height), max_h), Image.LANCZOS)
    name = os.path.splitext(os.path.basename(p))[0]
    prefix = 'expr_' if '/expr/' in p else ('pet_' if '/pet/' in p else '')
    dest = os.path.join(out_dir, f'{prefix}{name}.webp')
    out.save(dest, 'WEBP', quality=86, method=6)
    print(f'{prefix}{name}', out.size, 'bbox', bbox, f'{os.path.getsize(dest) // 1024}KB', round(time.time() - t, 1), 's', flush=True)
