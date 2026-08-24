# Build-time tool (run once, output committed). Takes the official SCAO DC 101 as
# downloaded from courts.michigan.gov and produces:
#
#   assets/dc101-template.pdf  — same two pages, form machinery stripped (we draw the
#                                values into the page itself, so nothing is editable
#                                and every renderer — Lob's print pipeline included —
#                                shows exactly what we filled), plus Liberation Sans
#                                fully embedded so Lob's "all fonts embedded" preflight
#                                passes.
#   assets/dc101-map.json      — where every field lives (page + rect in PDF points),
#                                plus the byte-surgery facts the runtime filler needs:
#                                page object numbers, their rewritten dicts, the next
#                                free object number and the offset of the last xref.
#
# The runtime filler (dc101.js) then never parses a PDF at all. It appends an
# incremental update — two redefined page objects and one overlay content stream per
# page — using only the numbers recorded here. Zero dependencies, deterministic.
#
#   python3 tools/build-dc101-map.py
#
# Requires: pypdf, fonttools (build machine only, never the server).

import json, re, zlib, sys, os
from pypdf import PdfReader, PdfWriter
from pypdf.generic import (DictionaryObject, NameObject, ArrayObject, NumberObject,
                           StreamObject, IndirectObject)
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'dc101.pdf')
TEMPLATE = os.path.join(ROOT, 'assets', 'dc101-template.pdf')
MAP = os.path.join(ROOT, 'assets', 'dc101-map.json')
TTF = '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'

# ---------- 1. field rectangles from the original ----------
reader = PdfReader(SRC)
fields = {}
for pi, page in enumerate(reader.pages):
    for a in (page.get('/Annots') or []):
        a = a.get_object()
        if a.get('/Subtype') != '/Widget':
            continue
        name = a.get('/T')
        if name is None and a.get('/Parent'):
            name = a['/Parent'].get_object().get('/T')
        if name is None:
            continue
        rect = [float(x) for x in a['/Rect']]
        ft = a.get('/FT') or (a.get('/Parent') and a['/Parent'].get_object().get('/FT'))
        fields[str(name)] = {'page': pi, 'rect': rect, 'type': str(ft or '')}

# ---------- 2. flattened template with an embedded font ----------
writer = PdfWriter()
writer.append(reader)
root = writer._root_object
if '/AcroForm' in root:
    del root[NameObject('/AcroForm')]
for page in writer.pages:
    if '/Annots' in page:
        del page[NameObject('/Annots')]

# Full Liberation Sans, WinAnsi-encoded simple TrueType font. Full file, no subset —
# the runtime writes arbitrary names and amounts.
ttf_bytes = open(TTF, 'rb').read()
font = TTFont(TTF)
upm = font['head'].unitsPerEm
scale = 1000.0 / upm
cmap = font.getBestCmap()
hmtx = font['hmtx']

# WinAnsi (cp1252) code -> unicode -> glyph width
widths = []
for code in range(32, 256):
    try:
        ch = bytes([code]).decode('cp1252')
        u = ord(ch)
    except Exception:
        u = None
    if u is not None and u in cmap:
        widths.append(int(round(hmtx[cmap[u]][0] * scale)))
    else:
        widths.append(0)

hhea, os2, head = font['hhea'], font['OS/2'], font['head']
bbox = [int(round(v * scale)) for v in (head.xMin, head.yMin, head.xMax, head.yMax)]

ff = StreamObject()
ff._data = zlib.compress(ttf_bytes, 9)
ff[NameObject('/Filter')] = NameObject('/FlateDecode')
ff[NameObject('/Length1')] = NumberObject(len(ttf_bytes))
ff_ref = writer._add_object(ff)

fd = DictionaryObject({
    NameObject('/Type'): NameObject('/FontDescriptor'),
    NameObject('/FontName'): NameObject('/LiberationSans'),
    NameObject('/Flags'): NumberObject(32),
    NameObject('/FontBBox'): ArrayObject([NumberObject(v) for v in bbox]),
    NameObject('/ItalicAngle'): NumberObject(0),
    NameObject('/Ascent'): NumberObject(int(round(hhea.ascent * scale))),
    NameObject('/Descent'): NumberObject(int(round(hhea.descent * scale))),
    NameObject('/CapHeight'): NumberObject(int(round(getattr(os2, 'sCapHeight', 716) * scale))),
    NameObject('/StemV'): NumberObject(88),
    NameObject('/FontFile2'): ff_ref,
})
fd_ref = writer._add_object(fd)

fnt = DictionaryObject({
    NameObject('/Type'): NameObject('/Font'),
    NameObject('/Subtype'): NameObject('/TrueType'),
    NameObject('/BaseFont'): NameObject('/LiberationSans'),
    NameObject('/FirstChar'): NumberObject(32),
    NameObject('/LastChar'): NumberObject(255),
    NameObject('/Widths'): ArrayObject([NumberObject(w) for w in widths]),
    NameObject('/FontDescriptor'): fd_ref,
    NameObject('/Encoding'): NameObject('/WinAnsiEncoding'),
})
fnt_ref = writer._add_object(fnt)

with open(TEMPLATE, 'wb') as f:
    writer.write(f)

# ---------- 3. re-read the template and record the surgery facts ----------
data = open(TEMPLATE, 'rb').read()
tpl = PdfReader(TEMPLATE)

def raw_object(idnum):
    m = re.search(rb'(?m)^' + str(idnum).encode() + rb' 0 obj\s*(.*?)\s*endobj',
                  data, re.S)
    if not m:
        sys.exit(f'object {idnum} not found in template')
    return m.group(1).decode('latin-1')

# The incremental update the runtime appends uses three new objects with numbers we
# can fix right now: SAVE_OBJ is a one-byte "q" stream shared by both pages (so the
# original content's graphics state can't bleed into ours), then one overlay stream
# per page. The page dicts that splice them in are therefore fully static — build
# them here, and the runtime never parses anything.
size = int(tpl.trailer['/Size'])
SAVE_OBJ, OV1_OBJ, OV2_OBJ = size, size + 1, size + 2

pages_out = []
for pi, page in enumerate(tpl.pages):
    idnum = page.indirect_reference.idnum
    raw = raw_object(idnum)
    if '/Resources' not in raw:
        sys.exit(f'page {idnum}: /Resources is indirect or missing — extend the tool')
    ov = OV1_OBJ if pi == 0 else OV2_OBJ
    m = re.search(r'/Contents\s+(\[[^\]]*\]|\d+ 0 R)', raw)
    if not m:
        sys.exit(f'page {idnum}: /Contents not found')
    old = m.group(1)
    inner = old[1:-1].strip() if old.startswith('[') else old
    raw = raw[:m.start()] + f'/Contents [ {SAVE_OBJ} 0 R {inner} {ov} 0 R ]' + raw[m.end():]
    m = re.search(r'/Font\s*<<', raw)
    if not m:
        sys.exit(f'page {idnum}: inline /Font dict not found — extend the tool')
    raw = raw[:m.end()] + f' /PPF {fnt_ref.idnum} 0 R ' + raw[m.end():]
    pages_out.append({'objNum': idnum, 'rewrittenDict': raw})

startxref = int(re.search(rb'startxref\s+(\d+)\s*%%EOF\s*$', data).group(1))
root_num = tpl.trailer['/Root'].indirect_reference.idnum
info = tpl.trailer.get('/Info')

out = {
    'source': 'SCAO DC 101 (Rev. 3/23), courts.michigan.gov',
    'templateBytes': len(data),
    'fontObjNum': fnt_ref.idnum,
    'lastXref': startxref,
    'rootObjNum': root_num,
    'infoObjNum': info.indirect_reference.idnum if info is not None else None,
    'saveObjNum': SAVE_OBJ,
    'overlayObjNums': [OV1_OBJ, OV2_OBJ],
    'newSize': OV2_OBJ + 1,
    'pages': pages_out,
    'fields': fields,
    # /Widths again, for the runtime: text is measured before it is placed, so a long
    # legal description shrinks to fit its box instead of marching off the page.
    'widths': widths,
}
with open(MAP, 'w') as f:
    json.dump(out, f, indent=1)
print(f'template {len(data)} bytes, {len(fields)} fields, font obj {fnt_ref.idnum}, '
      f'pages {[p["objNum"] for p in pages_out]}, size {size}')
