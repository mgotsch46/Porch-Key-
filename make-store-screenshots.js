// Turns raw phone captures into the two sets the stores actually accept.
//
// Apple's 6.9" slot wants exactly 1320x2868 and rejects anything else. Google caps the
// aspect ratio at 2:1 and takes 1080x1920. A raw iPhone capture is neither, and every
// capture is a slightly different height depending on where you stopped scrolling — so
// they have to be normalised, not just renamed.
//
//   node make-store-screenshots.js  <in-dir>  [out-dir]
//
// Files are matched to tabs by the ORDER given in SHOTS below, so name the inputs
// 1-home.jpg, 2-pay.jpg ... or pass them already in that order.
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');
let Image;
try { Image = require('sharp'); } catch { /* using PIL via python below */ }

const IN = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, 'store-assets');
if (!IN) { console.error('Usage: node make-store-screenshots.js <folder-of-captures> [out]'); process.exit(1); }

// The order a store shows them in, which is the order they should tell the story:
// what you owe, how you pay it, what the loan is, your paperwork, your history, your servicer.
const SHOTS = ['home', 'pay', 'loan', 'documents', 'history', 'messages'];

const py = `
from PIL import Image
import sys, os, glob, statistics
IN, OUT = sys.argv[1], sys.argv[2]
SHOTS = ${JSON.stringify(SHOTS)}
PAGE_BG = (248, 251, 244)
# The header height the set is normalised to, in source pixels.
HEADER_PX = 235

def edge(im, y):
    w = im.size[0]
    px = [im.getpixel((x, y)) for x in range(0, w, 4)]
    return tuple(int(statistics.median([p[c] for p in px])) for c in range(3))

def strip_scrollbar(im):
    """Paint out the browser scrollbar.

    These are captures of a web app, and Apple rejects screenshots showing browser
    chrome. A scrollbar is a PERSISTENT vertical grey bar at the right edge, so it is
    found by looking for columns that are grey down most of the image — that will not
    match a card border or a real bit of content, which are grey only briefly."""
    w, h = im.size
    px = im.load()
    rows = list(range(0, h, 4))
    def greyish(c):
        return abs(max(c) - min(c)) < 16 and 120 < sum(c) / 3 < 215
    bad = []
    for x in range(w - 32, w):
        hits = sum(1 for y in rows if greyish(px[x, y]))
        if hits / len(rows) > 0.25:
            bad.append(x)
    if not bad:
        return im
    left = min(bad) - 1
    while left > 0 and left in bad:
        left -= 1
    for y in range(h):
        fill = px[left, y]
        for x in bad:
            px[x, y] = fill
    return im

def trim_header(im, target):
    """Make every capture start with the same amount of header.

    Stopping a scroll at a slightly different place leaves a different amount of green
    band at the top. In a row of six on a store page that reads as six different apps,
    so the excess is trimmed off the top — it is solid colour, never content."""
    w, h = im.size
    px = im.load()
    def is_header(y):
        c = px[w // 2, y]
        return c[1] > c[0] + 18 and c[1] > c[2] + 18 and 120 < c[1] < 200
    band = 0
    while band < h and is_header(band):
        band += 1
    if band <= target + 8:
        return im
    return im.crop((0, band - target, w, h))

def ios(im):
    """1320x2868. The header and the tab bar are solid bands, so they are EXTENDED
    rather than letterboxed — on a taller phone those bands really are taller, so the
    result looks like the app instead of like a padded picture."""
    TW, TH = 1320, 2868
    im2 = im.resize((TW, round(im.size[1] * TW / im.size[0])), Image.LANCZOS)
    short = TH - im2.size[1]
    if short <= 0:
        return im2.crop((0, -short, TW, im2.size[1]))   # trim the header, never content
    top = round(short * 0.4); bot = short - top
    c = Image.new('RGB', (TW, TH), PAGE_BG)
    c.paste(Image.new('RGB', (TW, top), edge(im2, 0)), (0, 0))
    c.paste(Image.new('RGB', (TW, bot), edge(im2, im2.size[1]-1)), (0, top + im2.size[1]))
    c.paste(im2, (0, top))
    return c

def play(im):
    """1080x1920. Google refuses anything taller than 2:1, so the whole capture is
    fitted inside and the sides padded with the app's own background. Nothing cropped."""
    TW, TH = 1080, 1920
    s = min(TW/im.size[0], TH/im.size[1])
    im2 = im.resize((round(im.size[0]*s), round(im.size[1]*s)), Image.LANCZOS)
    c = Image.new('RGB', (TW, TH), PAGE_BG)
    c.paste(im2, ((TW-im2.size[0])//2, (TH-im2.size[1])//2))
    return c

files = sorted([f for f in glob.glob(os.path.join(IN, '*'))
                if f.lower().endswith(('.jpg','.jpeg','.png'))], key=os.path.getmtime)
if len(files) > len(SHOTS):
    files = files[-len(SHOTS):]
for d in ('ios-6.9', 'play-phone'):
    os.makedirs(os.path.join(OUT, d), exist_ok=True)

for i, f in enumerate(files):
    tab = SHOTS[i] if i < len(SHOTS) else 'extra%d' % i
    im = strip_scrollbar(Image.open(f).convert('RGB'))
    im = trim_header(im, HEADER_PX)
    a, b = ios(im), play(im)
    a.save(os.path.join(OUT, 'ios-6.9',   '%02d-%s.png' % (i+1, tab)))
    b.save(os.path.join(OUT, 'play-phone','%02d-%s.png' % (i+1, tab)))
    print('%02d %-10s <- %-14s %dx%d  ->  iOS %dx%d   Play %dx%d'
          % (i+1, tab, os.path.basename(f)[:12], im.size[0], im.size[1], a.size[0], a.size[1], b.size[0], b.size[1]))

print()
for d, want in (('ios-6.9',(1320,2868)), ('play-phone',(1080,1920))):
    fs2 = sorted(glob.glob(os.path.join(OUT, d, '*.png')))
    sizes = {Image.open(x).size for x in fs2}
    ok = sizes == {want}
    print('%-11s %d files, %s %s' % (d, len(fs2), sizes, 'OK' if ok else 'WRONG SIZE'))
    if len(fs2) < len(SHOTS):
        print('            missing: ' + ', '.join(SHOTS[len(fs2):]))
`;
fs.writeFileSync('/tmp/_mk.py', py);
execSync(`python3 /tmp/_mk.py "${IN}" "${OUT}"`, { stdio: 'inherit' });
