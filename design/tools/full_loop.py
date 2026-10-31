"""Full-body loops for the stage: steady, cut out and pack one Seedance clip.

Seedance keeps her standing in place, but its camera drifts: it pushes in a little in
the middle of a loop and is back by the end. On the stage her feet stand on a fixed
floor line, so every frame is first brought back to the first frame's framing. The
correction is a zoom plus a shift, fitted to features on her legs, skirt and shoes
(below the waist, where she hardly moves) and smoothed over time, so her own sway and
gestures stay. Then, as in alpha_loop.py: matte with isnet-general-use, smooth the
matte over neighbouring frames (the loop wraps), decontaminate edge colours, and write
a "stacked alpha" H.264 MP4, colour on top and matte below, which the page's WebGL
shader recombines.

Usage: python full_loop.py <in.mp4> <out.mp4> <height of one half, e.g. 960> [pet]

With "pet" (a pet walking on the spot, the camera following it) the features come from
its head and body instead, since its legs are what moves.
"""
import json, subprocess, sys, time
import cv2
import numpy as np
from PIL import Image
from rembg import new_session, remove

src, dst, out_h = sys.argv[1], sys.argv[2], int(sys.argv[3])
pet = len(sys.argv) > 4 and sys.argv[4] == 'pet'
t0 = time.time()


def read_frames(path):
    info = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
                                      '-of', 'json', path], capture_output=True, check=True).stdout)['streams'][0]
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, info['height'], info['width'], 3)


frames = read_frames(src)
# The clip ends on its first frame; drop the repeat so the loop has no stutter.
if np.abs(frames[-1].astype(np.int16) - frames[0]).mean() < 6:
    frames = frames[:-1]
n, H, W, _ = frames.shape

session = new_session('isnet-general-use')
masks = np.stack([np.asarray(remove(Image.fromarray(f), session=session, only_mask=True, post_process_mask=False), np.float32) / 255
                  for f in frames])
print(f'{n} frames matted in {time.time() - t0:.0f}s', flush=True)


def lower_body(mask):
    """Where to look for steady features: her silhouette below the waist (a pet's above its legs)."""
    ys = np.where((mask > 0.5).any(axis=1))[0]
    top, bottom = ys[0], ys[-1]
    m = (mask > 0.5).astype(np.uint8)
    if pet:
        m[top + int((bottom - top) * 0.65):] = 0
    else:
        m[: top + int((bottom - top) * 0.5)] = 0
    return cv2.dilate(m, np.ones((9, 9), np.uint8)) * 255


orb = cv2.ORB_create(5000, scaleFactor=1.15, nlevels=10, edgeThreshold=15, patchSize=21)
gray = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in frames]
k0, d0 = orb.detectAndCompute(gray[0], lower_body(masks[0]))
matcher = cv2.BFMatcher(cv2.NORM_HAMMING)

# Zoom s and shift (tx, ty) taking frame i onto frame 0: x0 = s * xi + t.
fit = np.zeros((n, 3))
fit[0] = (1, 0, 0)
weak = 0
for i in range(1, n):
    k, d = orb.detectAndCompute(gray[i], lower_body(masks[i]))
    pairs = [p for p in matcher.knnMatch(d, d0, k=2) if len(p) == 2]
    good = [a for a, b in pairs if a.distance < 0.78 * b.distance]
    a = np.float32([k[m.queryIdx].pt for m in good])
    b = np.float32([k0[m.trainIdx].pt for m in good])
    _, inl = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=5000, confidence=0.999)
    keep = inl.ravel().astype(bool) if inl is not None else np.zeros(len(a), bool)
    if keep.sum() < 25:
        weak += 1
        fit[i] = fit[i - 1]
        continue
    a, b = a[keep], b[keep]
    # Least squares with no rotation: the camera zooms and slides, it does not roll.
    A = np.zeros((2 * len(a), 3))
    A[0::2, 0], A[0::2, 1] = a[:, 0], 1
    A[1::2, 0], A[1::2, 2] = a[:, 1], 1
    fit[i] = np.linalg.lstsq(A, b.reshape(-1), rcond=None)[0]

# The camera moves smoothly; the estimates are a little noisy. Smooth round the loop.
kernel = np.exp(-0.5 * (np.arange(-6, 7) / 2.0) ** 2)
kernel /= kernel.sum()
padded = np.concatenate([fit[-6:], fit, fit[:6]])
smooth = np.stack([np.convolve(padded[:, j], kernel, mode='valid') for j in range(3)], axis=1)
smooth[0] = (1, 0, 0)
print(f'zoom {smooth[:, 0].min():.3f}..{smooth[:, 0].max():.3f}, shift x {smooth[:, 1].min():.0f}..{smooth[:, 1].max():.0f}, '
      f'y {smooth[:, 2].min():.0f}..{smooth[:, 2].max():.0f} px, {weak} frames with too few matches', flush=True)


def warp(img, s, tx, ty, border):
    M = np.float32([[s, 0, tx], [0, s, ty]])
    return cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC if s < 1 else cv2.INTER_LINEAR, borderMode=border)


colors = [warp(frames[i], *smooth[i], cv2.BORDER_REPLICATE).astype(np.float32) / 255 for i in range(n)]
alphas = [np.clip(warp(masks[i], *smooth[i], cv2.BORDER_CONSTANT), 0, 1) for i in range(n)]


def feet(a):
    """Bottom of the silhouette and the middle of its lowest strip."""
    rows = np.where((a > 0.5).any(axis=1))[0]
    b = rows[-1]
    strip = (a[b - int(H * 0.04): b + 1] > 0.5)
    xs = np.where(strip.any(axis=0))[0]
    return b, (xs[0] + xs[-1]) / 2


f0 = feet(alphas[0])
drift = np.array([[feet(a)[0] - f0[0], feet(a)[1] - f0[1]] for a in alphas])
print(f'feet after steadying: up/down {drift[:, 0].min():.0f}..{drift[:, 0].max():.0f} px, '
      f'sideways {drift[:, 1].min():.0f}..{drift[:, 1].max():.0f} px', flush=True)

smooth_a = [0.25 * alphas[(i - 1) % n] + 0.5 * alphas[i] + 0.25 * alphas[(i + 1) % n] for i in range(n)]


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


out_w = round(W * out_h / H / 2) * 2
enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{out_w}x{out_h * 2}', '-r', '24',
                        '-i', '-', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow',
                        '-movflags', '+faststart', dst], stdin=subprocess.PIPE)
for c, a in zip(colors, smooth_a):
    a = np.clip((a - 0.04) / (0.90 - 0.04), 0.0, 1.0)
    w = (1.0 - a) ** 4
    bg = blur(c * w[..., None], 18) / np.maximum(blur(w, 18), 1e-4)[..., None]
    f = np.where(a[..., None] > 0.03, (c - (1.0 - a[..., None]) * bg) / np.maximum(a[..., None], 0.03), c)
    f = np.clip(f, 0.0, 1.0)
    top = cv2.resize((f * 255).round().astype(np.uint8), (out_w, out_h), interpolation=cv2.INTER_AREA)
    bottom = cv2.resize((a * 255).round().astype(np.uint8), (out_w, out_h), interpolation=cv2.INTER_AREA)
    enc.stdin.write(np.vstack([top, np.repeat(bottom[..., None], 3, axis=2)]).tobytes())
enc.stdin.close()
enc.wait()
print(f'wrote {dst} ({out_w}x{out_h * 2}, {n} frames) in {time.time() - t0:.0f}s', flush=True)
