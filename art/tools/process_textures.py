"""Seamless pass + derived PBR maps for arena textures.

Usage: python -I process_textures.py <theme/name>=<candidate.png> ...
  e.g. temple/tile_top=/path/temple_tile_top_c2.png

For each texture:
  1. copy the chosen raw generation to art/source/textures/<theme>_<name>.png (master)
  2. resize to 1024
  3. seam pass (tiling textures only): T2 = roll(T, w/2, h/2); final = m*T + (1-m)*T2, where m is
     1 in the center and 0 on all four edges. Inside the outer 22% band the 0->1 transition follows
     a minimum-error cut between T and T2 (dynamic programming, like image quilting) and is then
     feathered, which avoids the ghosted double joints a plain linear ramp gives. The edges come
     entirely from T2, which wraps perfectly.
  4. verify: wrap seam error (|col0-colLast|, |row0-rowLast|) <= 1.2x the mean interior
     adjacent-pixel difference, else exit non-zero
  5. multi-scale height from luminance (broad/mid/fine high-passes, crevices pushed deeper),
     normal map from it (roll-based Sobel at 3 scales, coarse scales boosted so relief survives
     mipmapping; OpenGL / +Y up), ORM (R cavity AO, G roughness, B metalness 0); all wrap-aware
  6. write public/textures/<theme>/<name>_albedo.webp (lossy q90), _normal.webp and _orm.webp
     (near-lossless), _height.webp (8-bit lossless) + art/source/textures/height16/<flat>_height16.png,
     and previews art/previews/<flat>_{2x2,lit,height_preview,vs_original}.png;
     decoded files are seam-checked again
"""
import os, shutil, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from textures import TEXTURES

ROOT = "/Users/flo/work/code/brawlock"
REFS = os.environ.get("REFS", "")  # folder with tile1.png, tile2.png, tile3.png (originals)
N = 1024
CWEBP = "/opt/homebrew/bin/cwebp"
BAND, MARGIN, FEATHER = 0.22, 12, 3.0

# per material: normal strength, roughness base, roughness vs luminance, roughness vs height
MAT = {
    "temple/tile_top": (1.0, 0.82, -0.10, -0.08),
    "temple/tile_side": (1.0, 0.85, -0.08, -0.08),
    "volcanic/tile_top": (1.1, 0.55, 0.45, -0.10),
    "volcanic/tile_side": (1.2, 0.80, 0.15, -0.08),
    "overgrown/tile_top": (1.2, 0.88, -0.06, -0.06),
    "overgrown/tile_side": (1.2, 0.88, -0.06, -0.06),
    "shared/cliff_rock": (1.3, 0.86, -0.06, -0.08),
    "shared/ground_moss": (0.8, 0.94, -0.04, -0.04),
    "shared/lava_crust": (1.3, 0.90, 0.05, -0.06),
    "shared/scorch_decal": (0.4, 0.95, 0.0, 0.0),
}
# which original texture each one is compared against
REF_FOR = {"temple/tile_top": "tile1", "temple/tile_side": "tile1", "volcanic/tile_top": "tile1",
           "volcanic/tile_side": "tile1", "overgrown/tile_top": "tile1", "overgrown/tile_side": "tile1",
           "shared/cliff_rock": "tile3", "shared/ground_moss": "tile2", "shared/lava_crust": "tile3",
           "shared/scorch_decal": "tile3"}


def blur_wrap(x, sigma):
    """Periodic Gaussian blur via FFT (wraps, so it keeps seamless maps seamless)."""
    if sigma <= 0:
        return x
    H, W = x.shape[:2]
    fy = np.fft.fftfreq(H)[:, None]
    fx = np.fft.fftfreq(W)[None, :]
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (fx ** 2 + fy ** 2))
    if x.ndim == 2:
        return np.real(np.fft.ifft2(np.fft.fft2(x) * g))
    return np.stack([np.real(np.fft.ifft2(np.fft.fft2(x[..., c]) * g)) for c in range(x.shape[2])], -1)


def min_cut(cost):
    """cost: (rows, cols). Returns, per row, the column of the min-cost top-to-bottom path (|step|<=1)."""
    R, C = cost.shape
    acc = cost.copy()
    back = np.zeros((R, C), np.int64)
    for y in range(1, R):
        prev = acc[y - 1]
        left = np.concatenate(([np.inf], prev[:-1]))
        right = np.concatenate((prev[1:], [np.inf]))
        stack = np.stack([left, prev, right])
        k = np.argmin(stack, 0)
        acc[y] += stack[k, np.arange(C)]
        back[y] = np.arange(C) + k - 1
    path = np.zeros(R, np.int64)
    path[-1] = int(np.argmin(acc[-1]))
    for y in range(R - 1, 0, -1):
        path[y - 1] = back[y, path[y]]
    return path


def pick_shift(T, axis):
    """Roll offset near half size whose wrap pair (the two source lines that become the new
    edges) differs no more than a typical adjacent pair, so the seam does not land on a joint."""
    L = T.shape[axis]
    g = blur_wrap(T.mean(-1), 1.0)
    best, best_d = L // 2, np.inf
    for s in range(L // 2 - 48, L // 2 + 49, 2):
        a = np.take(g, L - s - 1, axis=axis)
        b = np.take(g, L - s, axis=axis)
        d = np.abs(a - b).mean()
        if d < best_d:
            best, best_d = s, d
    return best


def seam_pass(T):
    H, W = T.shape[:2]
    T2 = np.roll(T, (pick_shift(T, 0), pick_shift(T, 1)), (0, 1))
    err = blur_wrap(np.abs(T - T2).sum(-1), 1.5)
    b = int(BAND * W)
    xs = np.arange(W)[None, :]
    ys = np.arange(H)[:, None]
    m = np.ones((H, W))
    # left and right cuts (paths run top to bottom)
    pl = min_cut(err[:, MARGIN:b]) + MARGIN
    pr = min_cut(err[:, W - b:W - MARGIN]) + W - b
    m *= (xs >= pl[:, None]) * (xs <= pr[:, None])
    # top and bottom cuts (paths run left to right)
    pt = min_cut(err[MARGIN:b, :].T) + MARGIN
    pb = min_cut(err[H - b:H - MARGIN, :].T) + H - b
    m *= (ys >= pt[None, :]) * (ys <= pb[None, :])
    m = blur_wrap(m, FEATHER)
    edge = np.zeros((H, W), bool)
    edge[:MARGIN // 2] = edge[-(MARGIN // 2):] = True
    edge[:, :MARGIN // 2] = edge[:, -(MARGIN // 2):] = True
    m[edge] = 0.0
    m = np.clip(m, 0, 1)[..., None]
    return m * T + (1 - m) * T2


def seam_stats(F):
    f = F.astype(np.float64)
    seam_x = np.abs(f[:, 0] - f[:, -1]).mean()
    seam_y = np.abs(f[0] - f[-1]).mean()
    int_x = np.abs(f[:, 1:] - f[:, :-1]).mean()
    int_y = np.abs(f[1:] - f[:-1]).mean()
    return seam_x / int_x, seam_y / int_y


def _z(a):
    return (a - a.mean()) / (a.std() + 1e-6)


def sobel(h):
    """Wrap-aware Sobel. Returns (dh/dx to image right, dh/dy to image down)."""
    def r(a, dy, dx):
        return np.roll(a, (dy, dx), (0, 1))
    gx = (r(h, -1, -1) + 2 * r(h, 0, -1) + r(h, 1, -1)) - (r(h, -1, 1) + 2 * r(h, 0, 1) + r(h, 1, 1))
    gy = (r(h, -1, -1) + 2 * r(h, -1, 0) + r(h, -1, 1)) - (r(h, 1, -1) + 2 * r(h, 1, 0) + r(h, 1, 1))
    return gx / 8.0, gy / 8.0


def height_field(alb, alpha=None):
    """Multi-scale relief from luminance (z-scored). Broad structure (slab vs joint, plates) carries
    most weight so parallax and distant normals read; narrow dark crevices are pushed deeper."""
    lum = (alb[..., :3] / 255.0) @ np.array([0.299, 0.587, 0.114])
    broad = _z(blur_wrap(lum, 2.0) - blur_wrap(lum, 64))
    mid = _z(blur_wrap(lum, 1.0) - blur_wrap(lum, 12))
    fine = _z(lum - blur_wrap(lum, 3))
    crev = _z(np.maximum(blur_wrap(lum, 5) - lum, 0))
    h = 0.55 * broad + 0.30 * mid + 0.15 * fine - 0.35 * crev
    h = blur_wrap(h, 0.7)
    if alpha is not None:
        h = h * alpha
    return _z(h), lum


def maps(alb, key, alpha=None):
    """Returns normal (uint8 RGB, OpenGL +Y), ORM (uint8 RGB), height (float 0..1)."""
    strength, r0, r_lum, r_h = MAT[key]
    h, lum = height_field(alb, alpha)
    # gradients at three scales; the coarser ones are scaled up so relief survives mipmapping
    gx, gy = np.zeros_like(h), np.zeros_like(h)
    for sigma, w in ((0.0, 1.0), (3.0, 3.0), (8.0, 6.0)):
        ax, ay = sobel(blur_wrap(h, sigma) if sigma else h)
        gx += w * ax
        gy += w * ay
    mag = np.sqrt(gx ** 2 + gy ** 2)
    s = strength * 0.85 / (np.percentile(mag, 90) + 1e-6)
    n = np.stack([-gx * s, gy * s, np.ones_like(h)], -1)  # OpenGL convention: green = +V (up)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    normal = ((n * 0.5 + 0.5) * 255).round().clip(0, 255).astype(np.uint8)
    # height for parallax: robust 0..1 range, slight lift of the plateaus
    lo, hi = np.percentile(h, 0.5), np.percentile(h, 99.5)
    height = np.clip((h - lo) / (hi - lo), 0, 1) ** 0.9
    # ORM: R = cavity AO at two scales, G = roughness, B = metalness 0
    cav = 0.6 * np.maximum(blur_wrap(h, 6) - h, 0) + 0.4 * np.maximum(blur_wrap(h, 20) - h, 0)
    ao = blur_wrap(1 - 0.22 * cav, 0.8).clip(0.3, 1)
    ln = _z(lum)
    rough = (r0 + r_lum * 0.15 * ln + r_h * 0.15 * h).clip(0.08, 1)
    orm = np.stack([ao, rough, np.zeros_like(ao)], -1)
    orm = (orm * 255).round().clip(0, 255).astype(np.uint8)
    return normal, orm, height


def label(img, text):
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 22)
    except OSError:
        f = ImageFont.load_default()
    d.rectangle((0, 0, d.textlength(text, font=f) + 16, 34), fill=(0, 0, 0))
    d.text((8, 5), text, fill=(240, 235, 225), font=f)


def lit_preview(alb, normal, orm, height, path):
    """Raking-light check of the normal/AO: 512 crop at 100%, then the whole texture at 25%
    (box-downsampled like a mip) lit, unlit, and its height map."""
    L = np.array([-0.55, 0.45, 0.70])
    L /= np.linalg.norm(L)

    def shade(a, n, ao):
        Nn = n / 127.5 - 1
        Nn /= np.linalg.norm(Nn, axis=-1, keepdims=True)
        d = np.clip(Nn @ L, 0, 1)
        return np.clip(a * (0.25 + 1.1 * d[..., None]) * (ao[..., None] / 255.0), 0, 255).astype(np.uint8)

    def ds(x):
        return np.asarray(Image.fromarray(x.astype(np.uint8)).resize((256, 256), Image.BOX)).astype(np.float64)

    a, n, o = alb[..., :3].astype(np.float64), normal.astype(np.float64), orm.astype(np.float64)
    full = shade(a, n, o[..., 0])[:512, :512]
    q = shade(ds(a), ds(n), ds(o)[..., 0])
    flatq = np.clip(ds(a) * (0.25 + 1.1 * L[2]), 0, 255).astype(np.uint8)
    hq = Image.fromarray((height * 255).astype(np.uint8)).resize((256, 256), Image.BOX).convert("RGB")
    img = Image.new("RGB", (512 + 8 + 256, 512), (20, 18, 22))
    img.paste(Image.fromarray(full), (0, 0))
    img.paste(Image.fromarray(q), (520, 0))
    img.paste(Image.fromarray(flatq), (520, 256))
    img.save(path, optimize=True)
    hq.save(path.replace("_lit.png", "_height_preview.png"), optimize=True)


def process(key, cand):
    theme, name = key.split("/")
    flat = f"{theme}_{name}"
    tiling = TEXTURES[key][1]
    os.makedirs(f"{ROOT}/public/textures/{theme}", exist_ok=True)
    master = f"{ROOT}/art/source/textures/{flat}.png"
    if os.path.abspath(cand) != master:
        shutil.copyfile(cand, master)
    src = Image.open(master)
    has_alpha = src.mode in ("RGBA", "LA") and not tiling
    src = src.convert("RGBA" if has_alpha else "RGB")
    if has_alpha:
        src = src.convert("RGBa").resize((N, N), Image.LANCZOS).convert("RGBA")
    else:
        src = src.resize((N, N), Image.LANCZOS)
    A = np.asarray(src).astype(np.float64)
    if tiling:
        raw = seam_stats(A)
        F = seam_pass(A)
        F8 = F.round().clip(0, 255).astype(np.uint8)
        sx, sy = seam_stats(F8)
        ok = sx <= 1.2 and sy <= 1.2
        print(f"{flat}: raw seam ratio x={raw[0]:.2f} y={raw[1]:.2f} -> final x={sx:.2f} y={sy:.2f} {'OK' if ok else 'FAIL'}")
        if not ok:
            raise SystemExit(f"{flat}: seam check failed")
        alb = F8
        normal, orm, height = maps(F8.astype(np.float64), key)
        h8 = (height * 255).round().astype(np.uint8)
        for m_, nm in ((normal, "normal"), (orm, "orm"), (h8, "height")):
            mx, my = seam_stats(m_)
            if mx > 1.2 or my > 1.2:
                raise SystemExit(f"{flat}: {nm} seam check failed x={mx:.2f} y={my:.2f}")
    else:
        # kill the faint low-alpha haze the generator leaves in the "transparent" area, and force
        # a radial fade so the decal is exactly 0 at the borders
        a = np.clip((A[..., 3] / 255.0 - 0.04) / 0.96, 0, 1)
        yy, xx = np.mgrid[0:N, 0:N]
        r = np.hypot(xx - N / 2, yy - N / 2) / (N / 2)
        t = np.clip((0.98 - r) / (0.98 - 0.85), 0, 1)
        a *= t * t * (3 - 2 * t)
        A[..., 3] = a * 255
        alb = A.round().clip(0, 255).astype(np.uint8)
        a = alb[..., 3] / 255.0
        normal, orm, height = maps(alb.astype(np.float64), key, alpha=a)
        print(f"{flat}: decal, alpha edge max={a[[0, -1], :].max():.3f}/{a[:, [0, -1]].max():.3f}")
    out = f"{ROOT}/public/textures/{theme}/{name}"
    Image.fromarray(alb).save(f"{out}_albedo.webp", quality=90, method=6)
    # normal/ORM are smooth, so lossy WebP block artifacts at the borders break the seam check
    # (decoded ratio 1.3-2.6); near-lossless keeps them seamless at ~2x the size of q90.
    for arr, kind in ((normal, "normal"), (orm, "orm")):
        tmp = f"{out}_{kind}.tmp.png"
        Image.fromarray(arr).save(tmp)
        subprocess.run([CWEBP, "-quiet", "-mt", "-near_lossless", "40", tmp, "-o", f"{out}_{kind}.webp"], check=True)
        os.remove(tmp)
    if tiling:
        # height for parallax: 8-bit lossless WebP (what TextureLoader decodes anyway) plus a 16-bit
        # PNG master for a precise path (e.g. an R16 KTX2 later). The decal has no height (flat soot).
        Image.fromarray((height * 255).round().astype(np.uint8)).convert("RGB").save(
            f"{out}_height.webp", lossless=True, quality=100, method=6)
        os.makedirs(f"{ROOT}/art/source/textures/height16", exist_ok=True)
        Image.fromarray((height * 65535).round().astype(np.uint16)).save(
            f"{ROOT}/art/source/textures/height16/{flat}_height16.png")
        for kind in ("albedo", "normal", "orm", "height"):
            sx, sy = seam_stats(np.asarray(Image.open(f"{out}_{kind}.webp").convert("RGB")))
            if sx > 1.2 or sy > 1.2:
                raise SystemExit(f"{flat}: decoded {kind} seam check failed x={sx:.2f} y={sy:.2f}")
    # previews
    P = f"{ROOT}/art/previews"
    if tiling:
        t = Image.fromarray(alb).resize((512, 512), Image.LANCZOS)
        g = Image.new("RGB", (1024, 1024))
        for i in range(2):
            for j in range(2):
                g.paste(t, (i * 512, j * 512))
        g.save(f"{P}/{flat}_2x2.png", optimize=True)
        lit_preview(alb, normal, orm, height, f"{P}/{flat}_lit.png")
    ref = Image.open(f"{REFS}/{REF_FOR[key]}.png").convert("RGB").resize((768, 768), Image.LANCZOS)
    fin = Image.fromarray(alb)
    if fin.mode == "RGBA":
        bg = Image.new("RGBA", fin.size, (70, 66, 60, 255))
        bg.alpha_composite(fin)
        fin = bg
    fin = fin.convert("RGB").resize((768, 768), Image.LANCZOS)
    label(ref, f"original mod: {REF_FOR[key]} (512 px, upscaled)")
    label(fin, f"brawlock: {flat} (1024 px)")
    cmp_ = Image.new("RGB", (768 * 2 + 16, 768), (20, 18, 22))
    cmp_.paste(ref, (0, 0))
    cmp_.paste(fin, (768 + 16, 0))
    cmp_.save(f"{P}/{flat}_vs_original.png", optimize=True)


for arg in sys.argv[1:]:
    k, c = arg.split("=", 1)
    process(k, c)
