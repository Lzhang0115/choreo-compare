"""Download two full-body test photos from MediaPipe's public test assets and
cut the people out (writes cut_yoga.png and cut_man.png for gen_dance.py).

    python3 make_cutouts.py && python3 gen_dance.py OUTDIR
"""
import urllib.request
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

BASE = 'https://storage.googleapis.com/mediapipe-assets/'
for f in ['pose.jpg', 'pose_segmentation_mask_golden.png', 'male_full_height_hands.jpg']:
    urllib.request.urlretrieve(BASE + f, f)

# Yoga pose: a mask is provided.
im = np.asarray(Image.open('pose.jpg').convert('RGB'))
m = np.asarray(Image.open('pose_segmentation_mask_golden.png')) > 128
ys, xs = np.where(m)
rgba = np.dstack([im, (m * 255).astype(np.uint8)])[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
Image.fromarray(rgba, 'RGBA').save('cut_yoga.png')

# Standing man against a light wall and wood floor.
im = np.asarray(Image.open('male_full_height_hands.jpg').convert('RGB')).astype(int)
H, W, _ = im.shape
mx, mn = im.max(-1), im.min(-1)
yy = np.arange(H)[:, None].repeat(W, 1)
bg = (mx > 85) & ((mx - mn) < 40)
legcols = ~bg[int(0.70 * H)]
legcols = np.convolve(legcols.astype(float), np.ones(15), 'same') > 0
bg |= (yy > 0.73 * H) & ~legcols[None, :].repeat(H, 0)
bg |= (yy > 0.775 * H) & (mx > 70)
fg = Image.fromarray(((~bg) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(3))
fgm = np.asarray(fg) > 128
seen = np.zeros_like(fgm)
q = deque([(int(H * 0.45), int(W * 0.55))])
seen[q[0]] = True
while q:
    y, x = q.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < H and 0 <= nx < W and fgm[ny, nx] and not seen[ny, nx]:
            seen[ny, nx] = True
            q.append((ny, nx))
ys, xs = np.where(seen)
alpha = np.asarray(Image.fromarray((seen * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1)))
rgba = np.dstack([im.astype(np.uint8), alpha])[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
Image.fromarray(rgba, 'RGBA').save('cut_man.png')
print('wrote cut_yoga.png, cut_man.png')
