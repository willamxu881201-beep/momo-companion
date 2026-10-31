"""Full-body sprites for the kid screen, from Seedream renders of each girl.

For each girl: the base render and five poses are cut out (as in cut_stills.py) into
RGBA WebP; the mouth and blink edits are reduced to small face patches, because the
model redraws the whole picture a little differently each time and only the mouth or
the eyes may change between frames. A patch is the edit inside a feathered ellipse
around the part that changed, limited to the girl's own silhouette. sprites.json
records where each patch goes and where the mouth, face and feet are.

Usage: python full_body.py <raw_dir> <out_dir> <height>
  raw_dir holds fb_<g>.jpg (base), <g>_m1.jpg, <g>_m2.jpg, <g>_blink.jpg and
  <g>_<pose>.jpg for happy, cheer, think, sleepy, worried.
"""
import json, os, sys
import numpy as np
from PIL import Image
from rembg import new_session, remove

raw, out, height = sys.argv[1], sys.argv[2], int(sys.argv[3])
POSES = ['happy', 'cheer', 'think', 'sleepy', 'worried']
session = new_session('isnet-general-use')


def _box(arr, r, axis):
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (r + 1, r)
    cs = np.cumsum(np.pad(arr, pad, mode='edge'), axis=axis, dtype=np.float64)
    n = cs.shape[axis]
    return (np.take(cs, np.arange(2 * r + 1, n), axis=axis) - np.take(cs, np.arange(0, n - 2 * r - 1), axis=axis)) / (2 * r + 1)


def blur(arr, radius):
    r = max(1, round(radius * 0.6))
    o = arr.astype(np.float64)
    for _ in range(3):
        o = _box(_box(o, r, 0), r, 1)
    return o


def cut(path):
    """RGB float image and its decontaminated colours + alpha, as in cut_stills.py."""
    rgb = Image.open(path).convert('RGB')
    m = remove(rgb, session=session, only_mask=True, post_process_mask=False)
    c = np.asarray(rgb, dtype=np.float32) / 255
    a = np.clip((np.asarray(m, dtype=np.float32) / 255 - 0.04) / (0.90 - 0.04), 0, 1)
    w = (1 - a) ** 4
    bg = blur(c * w[..., None], 18) / np.maximum(blur(w, 18), 1e-4)[..., None]
    f = np.where(a[..., None] > 0.03, (c - (1 - a[..., None]) * bg) / np.maximum(a[..., None], 0.03), c)
    return np.clip(f, 0, 1), a


def save(rgba, path, scale):
    im = Image.fromarray((rgba * 255).round().astype(np.uint8), 'RGBA')
    if scale != 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    im.save(path, 'WEBP', quality=86, method=6)
    return im.size


def changes(base, edit, top_frac):
    """How much an edit changed each pixel of the head, smoothed."""
    h = int(base.shape[0] * top_frac)
    return blur(np.abs(edit[:h] - base[:h]).mean(axis=2), 6)


def region(sm, x0, x1, y0, y1, level):
    """Box around the strong changes inside a window. The model redraws everything a
    little, so only changes well above that noise count."""
    x0, y0 = max(0, int(x0)), max(0, int(y0))
    win = sm[y0:int(y1), x0:int(x1)]
    ys, xs = np.nonzero(win > win.max() * level)
    return x0 + xs.min(), y0 + ys.min(), x0 + xs.max(), y0 + ys.max()


def r3(v):
    return round(float(v), 4)


manifest = {}
os.makedirs(out, exist_ok=True)
for g in 'abcd':
    base_rgb, base_a = cut(os.path.join(raw, f'fb_{g}.jpg'))
    H, W = base_a.shape
    scale = height / H
    size = save(np.dstack([base_rgb, base_a]), os.path.join(out, f'{g}.webp'), scale)
    ys, xs = np.nonzero(base_a > 0.5)
    bbox = [xs.min() / W, ys.min() / H, xs.max() / W, ys.max() / H]
    legs = base_a[int(ys.max() - (ys.max() - ys.min()) * 0.25):ys.max() + 1]
    lx = np.nonzero(legs > 0.5)[1]
    feet = [(lx.min() + lx.max()) / 2 / W, ys.max() / H]
    entry = {'size': list(size), 'bbox': [r3(v) for v in bbox], 'feet': [r3(v) for v in feet], 'patches': {}, 'poses': {}}

    def img(name):
        return np.asarray(Image.open(os.path.join(raw, name)).convert('RGB'), dtype=np.float32) / 255

    raw_base = img(f'fb_{g}.jpg')
    # Where the mouth and an eye are: the strongest change of each edit.
    sm = changes(raw_base, img(f'{g}_m2.jpg'), 0.42)
    py, px = np.unravel_index(np.argmax(sm), sm.shape)
    mx0, my0, mx1, my1 = region(sm, px - 0.06 * W, px + 0.06 * W, py - 0.03 * H, py + 0.03 * H, 0.5)
    mouth = ((mx0 + mx1) / 2, (my0 + my1) / 2)
    sb = changes(raw_base, img(f'{g}_blink.jpg'), 0.42)
    ey, ex = np.unravel_index(np.argmax(sb), sb.shape)
    eyes = (mouth[0], float(ey))  # the two eyes sit either side of the mouth's line
    span = mouth[1] - eyes[1]  # eyes to mouth: the face's own unit of size
    entry['mouth'] = [r3(mouth[0] / W), r3(mouth[1] / H)]
    entry['face'] = [r3((mouth[0] - 1.55 * span) / W), r3((eyes[1] - 1.2 * span) / H), r3((mouth[0] + 1.55 * span) / W), r3((mouth[1] + 0.7 * span) / H)]

    def patch(name, x0, x1, y0, y1, square=False):
        """The edit wherever it really differs from the base: opaque where they differ,
        clear where they agree, so nothing shows twice. A soft window (oval, or nearly
        square to reach the corners of the eyes) keeps the model's small redraws of the
        rest of her out."""
        x0, x1, y0, y1 = int(max(0, x0)), int(min(W, x1)), int(max(0, y0)), int(min(H, y1))
        ed = img(f'{g}_{name}.jpg')[y0:y1, x0:x1]
        yy, xx = np.mgrid[y0:y1, x0:x1]
        cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
        if square:
            dist = ((np.abs(xx - cx) / rx) ** 4 + (np.abs(yy - cy) / ry) ** 4) ** 0.25
            window = np.clip((1 - dist) / 0.15, 0, 1)
        else:
            window = np.clip((1 - np.hypot((xx - cx) / rx, (yy - cy) / ry)) / 0.25, 0, 1)
        d = blur(np.abs(ed - raw_base[y0:y1, x0:x1]).mean(axis=2), 3)
        a = np.clip(blur(np.clip((d - 0.035) / 0.045, 0, 1), 6) * 1.8, 0, 1)
        alpha = a * window * base_a[y0:y1, x0:x1]
        save(np.dstack([ed, alpha]), os.path.join(out, f'{g}_{name}.webp'), scale)
        entry['patches'][name] = [r3(x0 / W), r3(y0 / H), r3((x1 - x0) / W), r3((y1 - y0) / H)]

    for k in ('m1', 'm2'):
        patch(k, mouth[0] - 0.95 * span, mouth[0] + 0.95 * span, mouth[1] - 0.5 * span, mouth[1] + 0.7 * span)
    dx = abs(ex - mouth[0])

    reach = dx + 0.9 * span
    # Closing the eyes also lowers the brows a little (the model does it, and so do
    # people). So the blink takes the brows too, and its edge lies on the forehead,
    # where the two pictures agree: a brief dip of the brows, never two of them.
    patch('blink', mouth[0] - reach, mouth[0] + reach, eyes[1] - 1.0 * span, eyes[1] + 0.45 * span, square=True)
    print(g, 'mouth', [int(v) for v in mouth], 'eye', [int(ex), int(ey)], 'span', int(span), flush=True)

    for p in POSES:
        dest = os.path.join(out, f'{g}_{p}.webp')
        if os.path.exists(dest):  # cutting takes a while; reuse an earlier run's sprite
            a = np.asarray(Image.open(dest).getchannel('A').resize((W, H)), dtype=np.float32) / 255
        else:
            rgb, a = cut(os.path.join(raw, f'{g}_{p}.jpg'))
            save(np.dstack([rgb, a]), dest, scale)
        ys2, xs2 = np.nonzero(a > 0.5)
        entry['poses'][p] = {'bbox': [r3(xs2.min() / W), r3(ys2.min() / H), r3(xs2.max() / W), r3(ys2.max() / H)]}
    manifest[g] = entry
    print(g, json.dumps(entry), flush=True)

json.dump(manifest, open(os.path.join(out, 'sprites.json'), 'w'), separators=(',', ':'))
