"""Turn one looping character video into a "stacked alpha" MP4: colour on top, matte below.

Every frame is matted with isnet-general-use, the matte is smoothed over neighbouring
frames (the loop wraps, so the first and last frames smooth into each other), edge
colours are decontaminated like the stills, and the result is written as H.264 that
plays everywhere; a WebGL shader recombines the two halves in the page.

Usage: python alpha_loop.py <in.mp4> <out.mp4> <work_dir>
"""
import glob, os, subprocess, sys, time
import numpy as np
from PIL import Image
from rembg import new_session, remove

src, dst, work = sys.argv[1], sys.argv[2], sys.argv[3]
fr_dir, st_dir = os.path.join(work, 'frames'), os.path.join(work, 'stacked')
os.makedirs(fr_dir, exist_ok=True)
os.makedirs(st_dir, exist_ok=True)
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, os.path.join(fr_dir, 'f%04d.png')], check=True)
frames = sorted(glob.glob(os.path.join(fr_dir, '*.png')))

session = new_session('isnet-general-use')
t0 = time.time()
colors, alphas = [], []
for f in frames:
    im = Image.open(f).convert('RGB')
    m = remove(im, session=session, only_mask=True, post_process_mask=False)
    colors.append(np.asarray(im, dtype=np.float32) / 255)
    alphas.append(np.asarray(m, dtype=np.float32) / 255)
print(f'matted {len(frames)} frames in {time.time() - t0:.0f}s', flush=True)

n = len(alphas)
smooth = [0.25 * alphas[(i - 1) % n] + 0.5 * alphas[i] + 0.25 * alphas[(i + 1) % n] for i in range(n)]


def _box(arr, r, axis):
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (r + 1, r)
    cs = np.cumsum(np.pad(arr, pad, mode='edge'), axis=axis, dtype=np.float64)
    k = cs.shape[axis]
    return (np.take(cs, np.arange(2 * r + 1, k), axis=axis) - np.take(cs, np.arange(0, k - 2 * r - 1), axis=axis)) / (2 * r + 1)


def blur(arr, radius):
    r = max(1, round(radius * 0.6))
    out = arr.astype(np.float64)
    for _ in range(3):
        out = _box(_box(out, r, 0), r, 1)
    return out


for i, (c, a) in enumerate(zip(colors, smooth)):
    a = np.clip((a - 0.04) / (0.90 - 0.04), 0.0, 1.0)
    w = (1.0 - a) ** 4
    bg = blur(c * w[..., None], 18) / np.maximum(blur(w, 18), 1e-4)[..., None]
    f = np.where(a[..., None] > 0.03, (c - (1.0 - a[..., None]) * bg) / np.maximum(a[..., None], 0.03), c)
    f = np.clip(f, 0.0, 1.0)
    matte = np.repeat(a[..., None], 3, axis=2)
    Image.fromarray((np.vstack([f, matte]) * 255).round().astype(np.uint8), 'RGB').save(os.path.join(st_dir, f'f{i + 1:04d}.png'))
print(f'composed in {time.time() - t0:.0f}s', flush=True)

subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', '24', '-i', os.path.join(st_dir, 'f%04d.png'),
                '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '21', '-preset', 'slow',
                '-movflags', '+faststart', dst], check=True)
print('wrote', dst, os.path.getsize(dst) // 1024, 'KB', flush=True)
