"""Synthetic group-dance test videos with ground truth.

Usage: python3 gen_dance.py OUTDIR
Writes practice_frames/official_frames as raw RGB to ffmpeg, plus truth JSON.
"""
import json, math, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = sys.argv[1]
W, H, FPS = 960, 540, 24
rng = np.random.default_rng(5)

# ---------------------------------------------------------------- sprites
def load(path):
    return np.asarray(Image.open(path).convert('RGBA')).astype(np.float32)

BASE = {'man': load('cut_man.png'), 'yoga': load('cut_yoga.png')}
SPLIT = {'man': 0.50, 'yoga': 0.45}  # fraction of height where top -> bottom clothing

def skin_mask(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a[..., :3].max(-1), a[..., :3].min(-1)
    return (r > 95) & (g > 40) & (b > 20) & (r > g) & (r > b) & ((r - g) > 12) & ((mx - mn) > 15)

def recolor(kind, top, bottom):
    a = BASE[kind].copy()
    h = a.shape[0]
    cloth = (a[..., 3] > 10) & ~skin_mask(a)
    lum = (a[..., :3].mean(-1) / 255.0)[..., None]
    yy = np.arange(h)[:, None].repeat(a.shape[1], 1)
    for col, sel in ((top, yy < SPLIT[kind] * h), (bottom, yy >= SPLIT[kind] * h)):
        if col is None:
            continue
        m = cloth & sel
        c = np.array(col, np.float32)[None, None, :]
        tinted = np.clip(c * (0.35 + 1.1 * lum), 0, 255)
        a[..., :3] = np.where(m[..., None], tinted, a[..., :3])
    return a

def sprite_image(arr, height, flip):
    im = Image.fromarray(arr.astype(np.uint8), 'RGBA')
    w = max(1, int(round(im.width * height / im.height)))
    im = im.resize((w, max(1, int(round(height)))), Image.BILINEAR)
    if flip:
        im = im.transpose(Image.FLIP_LEFT_RIGHT)
    return im

# ---------------------------------------------------------------- choreography (song time tau)
V = [(-0.6, 0.7), (-0.3, 0.45), (0.0, 0.2), (0.3, 0.45), (0.6, 0.7)]
LINE = [(-0.7, 0.4), (-0.35, 0.4), (0.0, 0.4), (0.35, 0.4), (0.7, 0.4)]
KEYS = [
    (0, V), (4, V),
    (7, LINE),
    (9.5, [(-0.1, 0.25), (-0.35, 0.4), (0.0, 0.4), (0.35, 0.4), (0.1, 0.6)]),   # 0 and 4 cross (0 in front)
    (12, [(0.7, 0.4), (-0.35, 0.4), (0.0, 0.4), (0.35, 0.4), (-0.7, 0.4)]),
    (16, [(0.6, 0.65), (0.0, 0.65), (-0.4, 0.25), (-0.6, 0.65), (0.4, 0.25)]),  # two rows
    (20, [(0.15, 0.35), (-0.15, 0.35), (0.0, 0.5), (-0.3, 0.55), (0.3, 0.55)]),  # tight cluster
    (23, [(0.15, 0.35), (-0.15, 0.35), (0.0, 0.5), (-0.3, 0.55), (0.3, 0.55)]),
    (27, [(0.7, 0.15), (-0.35, 0.62), (0.0, 0.45), (-0.7, 0.8), (0.35, 0.3)]),   # diagonal
    (31, [(-0.35, 0.62), (0.0, 0.45), (-0.7, 0.8), (0.35, 0.3), (0.7, 0.15)]),   # rotate along it
    (36, V), (40, LINE), (60, LINE),
]

def ease(x):
    return 0.5 - 0.5 * math.cos(math.pi * x)

def choreo(tau):
    tau = max(0.0, tau)
    for (t0, p0), (t1, p1) in zip(KEYS, KEYS[1:]):
        if t0 <= tau <= t1:
            f = ease((tau - t0) / (t1 - t0))
            return [(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f) for a, b in zip(p0, p1)]
    return KEYS[-1][1]

BEAT = 60 / 124
HEIGHTS = [1.0, 0.92, 1.08, 0.95, 1.03]
KINDS = ['man', 'yoga', 'man', 'yoga', 'man']

# ---------------------------------------------------------------- cameras
CAMS = {
    'practice': dict(horizon=0.30, front=0.95, depth=0.45, k=0.80, spread=0.60, cx=0.50),
    'official': dict(horizon=0.22, front=0.97, depth=0.50, k=0.90, spread=0.66, cx=0.53),
}

def project(cam, u, v):
    c = CAMS[cam]
    foot = (c['front'] - v * c['depth']) * H
    persp = (foot - c['horizon'] * H) / ((c['front'] - c['horizon']) * H)
    x = c['cx'] * W + u * c['spread'] * W * persp
    height = c['k'] * (foot - c['horizon'] * H)
    return x, foot, height

# ---------------------------------------------------------------- backgrounds
def practice_bg():
    im = Image.new('RGB', (W, H), (214, 200, 178))
    d = ImageDraw.Draw(im)
    floor_y = int(0.46 * H)
    d.rectangle([0, floor_y, W, H], fill=(150, 104, 66))
    for i in range(0, W, 38):
        d.line([(i, floor_y), (i + (i - W / 2) * 0.9, H)], fill=(128, 88, 55), width=2)
    # mirror
    d.rectangle(MIRROR, fill=(178, 190, 196), outline=(235, 235, 235), width=5)
    # ballet bar across the mirror
    by = int(0.36 * H)
    d.rectangle([int(0.06 * W), by, int(0.94 * W), by + 7], fill=(120, 80, 40))
    for x in (0.1, 0.5, 0.9):
        d.rectangle([int(x * W) - 4, by, int(x * W) + 4, floor_y], fill=(90, 90, 90))
    # backpacks and a water bottle
    for (x, y, col) in ((0.06, 0.88, (30, 60, 140)), (0.12, 0.9, (160, 30, 40)), (0.93, 0.86, (40, 40, 40))):
        cx, cy = int(x * W), int(y * H)
        d.rounded_rectangle([cx - 34, cy - 46, cx + 34, cy + 30], radius=18, fill=col, outline=(15, 15, 15), width=3)
        d.rectangle([cx - 20, cy - 10, cx + 20, cy + 14], fill=tuple(min(255, c + 40) for c in col))
    d.rectangle([int(0.97 * W), int(0.8 * H), int(0.985 * W), int(0.9 * H)], fill=(90, 170, 220))
    # poster
    d.rectangle([int(0.94 * W), int(0.08 * H), int(0.995 * W), int(0.3 * H)], fill=(230, 80, 120))
    return im

def official_bg():
    im = Image.new('RGB', (W, H), (52, 52, 58))
    d = ImageDraw.Draw(im)
    d.rectangle([0, int(0.40 * H), W, H], fill=(96, 96, 104))
    return im

MIRROR = (int(0.08 * W), int(0.03 * H), int(0.92 * W), int(0.44 * H))

# ---------------------------------------------------------------- render
PRACTICE_COLORS = [((210, 30, 30), None), ((245, 245, 245), (40, 80, 200)), (None, None), ((240, 210, 30), (120, 120, 120)), ((30, 170, 60), None)]
OFFICIAL_COLORS = [((255, 105, 180), (240, 240, 240)), ((110, 190, 255), None), (None, (240, 240, 240)), ((150, 80, 220), None), ((255, 140, 30), (40, 40, 40))]

def make_sprites(colors):
    out = []
    for i, (top, bottom) in enumerate(colors):
        out.append(recolor(KINDS[i], top, bottom))
    return out

def render(cam, duration, tau_of_t, colors, bg, mirror, jitter):
    sprites = make_sprites(colors)
    n = int(duration * FPS)
    truth = []
    proc = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                             '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', f'{OUT}/{cam}_video.mp4'], stdin=subprocess.PIPE)
    walk = np.zeros((5, 2))
    for f in range(n):
        t = f / FPS
        tau = tau_of_t(t)
        pos = choreo(tau - (0.15 if jitter else 0))
        if jitter:
            walk += rng.normal(0, 0.004, walk.shape)
            walk *= 0.995
            walk = np.clip(walk, -0.07, 0.07)
        frame = bg.copy()
        flip = int(tau / BEAT) % 2 == 1
        bounce = 1 + 0.03 * math.sin(2 * math.pi * tau / BEAT)
        people = []
        for i, (u, v) in enumerate(pos):
            if jitter:
                u, v = u * 0.93 + walk[i, 0], v + walk[i, 1]
            x, foot, hgt = project(cam, u, v)
            people.append((foot, i, x, hgt * HEIGHTS[i] * bounce))
        boxes = []
        if mirror:
            # reflections: mirrored, smaller, dimmer, inside the mirror area
            for foot, i, x, hgt in sorted(people, key=lambda p: -p[0]):
                sp = sprite_image(sprites[i], hgt * 0.42, not flip)
                sp.putalpha(sp.getchannel('A').point(lambda a: int(a * 0.85)))
                xr = W / 2 + (x - W / 2) * 0.8
                fy = MIRROR[3] - 6 - (foot - 0.5 * H) * 0.08
                px, py = int(xr - sp.width / 2), int(fy - sp.height)
                layer = Image.new('RGBA', (W, H))
                layer.paste(sp, (px, py))
                clip = Image.new('L', (W, H), 0)
                ImageDraw.Draw(clip).rectangle(MIRROR, fill=255)
                layer.putalpha(Image.composite(layer.getchannel('A'), Image.new('L', (W, H), 0), clip))
                frame.paste(layer, (0, 0), layer)
                boxes.append({'id': f'r{i}', 'box': [px, py, sp.width, sp.height]})
        for foot, i, x, hgt in sorted(people):   # far (small foot y) first
            sp = sprite_image(sprites[i], hgt, flip)
            px, py = int(x - sp.width / 2), int(foot - sp.height)
            frame.paste(sp, (px, py), sp)
            boxes.append({'id': i, 'box': [px, py, sp.width, sp.height]})
        truth.append({'t': round(t, 4), 'people': boxes})
        proc.stdin.write(frame.tobytes())
    proc.stdin.close()
    proc.wait()
    return truth

if __name__ == '__main__':
    # Official: song time == video time. Practice: video t shows song time t + 3.
    off = render('official', 44, lambda t: t, OFFICIAL_COLORS, official_bg(), mirror=False, jitter=False)
    pra = render('practice', 40, lambda t: t + 3, PRACTICE_COLORS, practice_bg(), mirror=True, jitter=True)
    json.dump({'official': off, 'practice': pra, 'fps': FPS, 'mirror': MIRROR, 'W': W, 'H': H}, open(f'{OUT}/truth.json', 'w'))
    print('frames', len(off), len(pra))
