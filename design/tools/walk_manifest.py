"""Sizes for the pets' walking loops, so a walking pet looks as big as it does sitting
and its feet stay on the same floor point when it switches between the two.

For each walking loop made by full_loop.py (stacked alpha, colour over matte) and the
pet's sitting sprite (web/img/pet/sprite/<key>.webp), writes into walks.json:
  [width / height of the loop, its height as a share of the pet's box,
   where its feet are (share of its height from the top), how far the sitting pet's
   feet are above the box's bottom (share of the box)]
A standing pet is a little shorter than a sitting one, so it is drawn at WALK_SIZE of
the sitting pet's height.

Usage: python walk_manifest.py <loops_dir> <sprite_dir> <out.json>
"""
import glob, json, os, subprocess, sys
import numpy as np
from PIL import Image

loops, sprites, out = sys.argv[1], sys.argv[2], sys.argv[3]
WALK_SIZE = 0.9


def matte_rows(path):
    info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
                          capture_output=True, check=True, text=True).stdout.strip().split(',')
    w, h = int(info[0]), int(info[1])
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', 'select=not(mod(n\\,6))', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w)[:, h // 2:, :]
    tops, bottoms = [], []
    for a in frames:
        rows = np.where((a > 128).any(axis=1))[0]
        tops.append(rows[0])
        bottoms.append(rows[-1])
    return w, h // 2, float(np.median(tops)), float(np.median(bottoms))


manifest = {}
for path in sorted(glob.glob(os.path.join(loops, '*.mp4'))):
    key = os.path.basename(path)[:-4]
    w, h, top, bottom = matte_rows(path)
    sit = np.asarray(Image.open(os.path.join(sprites, f'{key}.webp')).convert('RGBA'))[..., 3]
    rows = np.where((sit > 128).any(axis=1))[0]
    sit_h = (rows[-1] - rows[0]) / sit.shape[0]
    lift = 1 - rows[-1] / sit.shape[0]
    walk_h = (bottom - top) / h
    scale = WALK_SIZE * sit_h / walk_h
    manifest[key] = [round(w / h, 4), round(scale, 4), round(bottom / h, 4), round(lift, 4)]
    print(key, manifest[key])
json.dump(manifest, open(out, 'w'), separators=(',', ':'))
