// A small PDF writer, no dependencies.
//
// Same reasoning as sms.js talking to Twilio over fetch and email.js speaking SMTP
// directly: a letter is a few paragraphs on a page, and pulling in a rendering engine
// to produce one is a lot of weight for what it does.
//
// What it makes: a business letter. Letterhead, a title, paragraphs, key/value tables,
// a signature block, page numbers, and page breaks that happen on their own. Helvetica
// only, because those are the fonts every PDF reader already has, so nothing has to be
// embedded and the file stays a few kilobytes.

const zlib = require('node:zlib');

const PAGE = { w: 612, h: 792 };            // US Letter at 72dpi
const MARGIN = { top: 64, bottom: 64, left: 64, right: 64 };
const CONTENT_W = PAGE.w - MARGIN.left - MARGIN.right;

// Widths of Helvetica at 1pt, indexed by character code. Enough to wrap text properly
// rather than guessing at an average character width and hoping.
const HELV = [
  278,278,278,278,278,278,278,278,278,278,278,278,278,278,278,278,278,278,278,278,
  278,278,278,278,278,278,278,278,278,278,278,278,
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];
const widthOf = (ch, bold) => {
  const c = ch.charCodeAt(0);
  const w = c < HELV.length ? HELV[c] : 556;
  // Helvetica-Bold runs a little wider; close enough for wrapping, and erring wide
  // means a line never overflows the margin.
  return bold ? w * 1.06 : w;
};
const textWidth = (s, size, bold) =>
  String(s).split('').reduce((t, ch) => t + widthOf(ch, bold), 0) * size / 1000;

// Wrap on spaces; break a word that is longer than the line rather than let it run off.
function wrap(text, size, bold, maxW) {
  const out = [];
  for (const para of String(text == null ? '' : text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const candidate = line ? line + ' ' + word : word;
      if (textWidth(candidate, size, bold) <= maxW) { line = candidate; continue; }
      if (line) out.push(line);
      if (textWidth(word, size, bold) <= maxW) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (textWidth(chunk + ch, size, bold) > maxW) { out.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    }
    if (line) out.push(line);
  }
  return out;
}

// PDF strings are parenthesised, so those three characters have to be escaped. Anything
// outside Latin-1 is transliterated rather than written as a byte the reader will
// mangle — a smart quote arriving as garbage looks worse than a straight one.
const SUBS = { '’': "'", '‘': "'", '“': '"', '”': '"',
               '–': '-', '—': '--', '…': '...', ' ': ' ', '•': '-' };
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[’‘“”–—… •]/g, c => SUBS[c])
    .replace(/[^\x20-\xFF]/g, '?')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// ---------- images ----------
// PDF takes a JPEG as-is, but a PNG has to be decoded first: its pixel data is
// deflate-compressed *after* a per-row filter is applied, and PDF knows nothing about
// those filters. So inflate, undo the filtering, flatten any transparency onto white
// (paper is white, and a logo drawn with a hole in it looks broken), and re-deflate.

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let pos = 8, idat = [], ihdr = null, plte = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = {
      width: data.readUInt32BE(0), height: data.readUInt32BE(4),
      depth: data[8], colorType: data[9], interlace: data[12],
    };
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no header');
  if (ihdr.depth !== 8) throw new Error(`Only 8-bit PNGs are supported (this one is ${ihdr.depth}-bit)`);
  if (ihdr.interlace !== 0) throw new Error('Interlaced PNGs are not supported');

  const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const ch = CHANNELS[ihdr.colorType];
  if (!ch) throw new Error(`Unsupported PNG colour type ${ihdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);

  // Undo the per-row filter. Each row starts with a filter byte, and every filter
  // refers back to the pixel to the left and the row above.
  let ri = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[ri++];
    const row = raw.subarray(ri, ri + stride); ri += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error(`Unknown PNG row filter ${filter}`);
      cur[x] = v & 0xff;
    }
  }

  // Flatten to RGB over white.
  const rgb = Buffer.alloc(w * h * 3);
  const over = (v, alpha) => Math.round(v * (alpha / 255) + 255 * (1 - alpha / 255));
  for (let i = 0, o = 0; i < w * h; i++) {
    const p = i * ch;
    let r, g, b, alpha = 255;
    if (ihdr.colorType === 0) { r = g = b = out[p]; }
    else if (ihdr.colorType === 4) { r = g = b = out[p]; alpha = out[p + 1]; }
    else if (ihdr.colorType === 2) { r = out[p]; g = out[p + 1]; b = out[p + 2]; }
    else if (ihdr.colorType === 6) { r = out[p]; g = out[p + 1]; b = out[p + 2]; alpha = out[p + 3]; }
    else { // palette
      const idx = out[p];
      r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2];
      if (trns && idx < trns.length) alpha = trns[idx];
    }
    rgb[o++] = over(r, alpha); rgb[o++] = over(g, alpha); rgb[o++] = over(b, alpha);
  }
  return { width: w, height: h, rgb };
}

// A letterhead logo does not need to be 800px wide. Box-average down so the file stays
// small and the edges stay smooth — a nearest-neighbour shrink makes text in a logo
// look chewed.
function downscale({ width, height, rgb }, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale >= 1) return { width, height, rgb };
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(nw * nh * 3);
  const xr = width / nw, yr = height / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.min(height, Math.ceil((y + 1) * yr));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.min(width, Math.ceil((x + 1) * xr));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const p = (sy * width + sx) * 3;
        r += rgb[p]; g += rgb[p + 1]; b += rgb[p + 2]; n++;
      }
      const o = (y * nw + x) * 3;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
  }
  return { width: nw, height: nh, rgb: out };
}

// JPEG goes in untouched — PDF decodes it natively. Only the dimensions are needed,
// which live in the SOF marker.
function jpegInfo(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('Could not read the JPEG dimensions');
}

// Returns what the PDF needs to embed the picture, whatever it arrived as.
function prepareImage(buf, { maxEdge = 320 } = {}) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const png = downscale(decodePng(buf), maxEdge);
    return {
      width: png.width, height: png.height, filter: 'FlateDecode',
      colorSpace: 'DeviceRGB', data: zlib.deflateSync(png.rgb, { level: 9 }),
    };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpegInfo(buf);
    return {
      width: j.width, height: j.height, filter: 'DCTDecode',
      colorSpace: j.components === 1 ? 'DeviceGray' : 'DeviceRGB', data: buf,
    };
  }
  throw new Error('Only PNG and JPEG logos are supported');
}

class Doc {
  constructor({ title = '', footer = '' } = {}) {
    this.title = title;
    this.footer = footer;
    this.images = [];        // shared across pages, written once
    this.pages = [];
    this.newPage();
  }
  // Draws at the current position unless x/y are given. Height follows from the
  // image's own proportions, so a logo is never stretched.
  image(buf, { width = 90, x = MARGIN.left, y = null } = {}) {
    let img;
    try { img = prepareImage(buf); }
    catch { return null; }                 // a bad logo must not cost you the letter
    const h = width * (img.height / img.width);
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, ...img });
    const top = y == null ? this.y : y;
    if (y == null) { this.room(h + 6); }
    const drawY = (y == null ? this.y : top) - h;
    this.ops.push(`q ${width} 0 0 ${h} ${x} ${drawY} cm /${name} Do Q`);
    if (y == null) this.y -= h + 6;
    return { width, height: h };
  }
  newPage() {
    this.ops = [];
    this.y = PAGE.h - MARGIN.top;
    this.pages.push(this.ops);
  }
  // Ask for room before drawing. If it isn't there, start a page.
  room(h) {
    if (this.y - h < MARGIN.bottom) { this.newPage(); return true; }
    return false;
  }
  text(str, { size = 10, bold = false, x = MARGIN.left, gap = 4, color = '0 0 0' } = {}) {
    const lines = wrap(str, size, bold, MARGIN.left + CONTENT_W - x);
    for (const line of lines) {
      this.room(size + gap);
      this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} rg ` +
                    `1 0 0 1 ${x} ${this.y - size} Tm (${esc(line)}) Tj ET`);
      this.y -= size + gap;
    }
    return this;
  }
  heading(str, size = 15) { this.space(6); this.text(str, { size, bold: true, gap: 6 }); return this; }
  space(h = 10) { this.y -= h; return this; }
  rule(color = '0.85 0.85 0.85') {
    this.room(10);
    this.ops.push(`${color} RG 0.7 w ${MARGIN.left} ${this.y} m ${MARGIN.left + CONTENT_W} ${this.y} l S`);
    this.y -= 10;
    return this;
  }
  // Label on the left, value hard against the right margin — how a statement reads.
  row(label, value, { size = 10, bold = false } = {}) {
    this.room(size + 6);
    const right = MARGIN.left + CONTENT_W;
    const vw = textWidth(value, size, bold);
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 0 0 0 rg ` +
                  `1 0 0 1 ${MARGIN.left} ${this.y - size} Tm (${esc(label)}) Tj ET`);
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 0 0 0 rg ` +
                  `1 0 0 1 ${right - vw} ${this.y - size} Tm (${esc(value)}) Tj ET`);
    this.y -= size + 6;
    return this;
  }
  letterhead(company, { subtitle, logo } = {}) {
    const name = (company && (company.mgmt_company_name || company.name)) || 'Porch Pay';
    // Logo on the left, company details to the right of it — a normal letterhead.
    // Without a logo the text simply starts at the margin.
    let textX = MARGIN.left;
    if (logo) {
      const top = this.y;
      const placed = this.image(logo, { width: 76, x: MARGIN.left, y: top });
      if (placed) {
        textX = MARGIN.left + placed.width + 16;
        this._logoBottom = top - placed.height;
        this.y = top;
      }
    }
    this.text(name, { size: 16, bold: true, gap: 3, x: textX });
    this._headX = textX;
    const addr = company ? [company.mailing_address,
      [company.mailing_city, company.mailing_state].filter(Boolean).join(', '),
      company.mailing_zip].filter(Boolean).join('  ') : '';
    const contact = company ? [company.rep_name, company.rep_phone, company.contact_email]
      .filter(Boolean).join('  ·  ') : '';
    if (addr) this.text(addr, { size: 9, gap: 2, x: textX });
    if (contact) this.text(contact, { size: 9, gap: 2, x: textX });
    if (subtitle) this.text(subtitle, { size: 9, gap: 2, x: textX });
    // The logo may hang lower than the text beside it; don't let the rule cut through it.
    if (logo && this._logoBottom != null && this.y > this._logoBottom) this.y = this._logoBottom;
    this.space(4); this.rule();
    return this;
  }

  build() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };   // 1-based

    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold    = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    // Images are written once and shared by every page that draws them. latin1 maps
    // bytes 0-255 one-to-one both ways, so compressed image data survives being held
    // as a string and written out with the rest of the file.
    const imgRefs = [];
    for (const im of this.images) {
      const id = add(`<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} ` +
        `/ColorSpace /${im.colorSpace} /BitsPerComponent 8 /Filter /${im.filter} ` +
        `/Length ${im.data.length} >>\nstream\n${im.data.toString('latin1')}\nendstream`);
      imgRefs.push({ name: im.name, id });
    }
    const xobj = imgRefs.length
      ? ` /XObject << ${imgRefs.map(r => `/${r.name} ${r.id} 0 R`).join(' ')} >>` : '';

    const pagesId = objs.length + 1 + this.pages.length * 2 + 1;   // placeholder, fixed below

    const pageIds = [];
    this.pages.forEach((ops, i) => {
      const foot = [];
      if (this.footer) {
        foot.push(`BT /F1 8 Tf 0.45 0.45 0.45 rg 1 0 0 1 ${MARGIN.left} ${MARGIN.bottom - 22} Tm (${esc(this.footer)}) Tj ET`);
      }
      const label = `Page ${i + 1} of ${this.pages.length}`;
      const lw = textWidth(label, 8, false);
      foot.push(`BT /F1 8 Tf 0.45 0.45 0.45 rg 1 0 0 1 ${MARGIN.left + CONTENT_W - lw} ${MARGIN.bottom - 22} Tm (${esc(label)}) Tj ET`);

      const stream = ops.concat(foot).join('\n');
      const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>${xobj} >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    });

    const realPagesId = add(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
    // The page objects were written pointing at pagesId; make that the real one.
    for (const id of pageIds) objs[id - 1] = objs[id - 1].replace(`/Parent ${pagesId} 0 R`, `/Parent ${realPagesId} 0 R`);
    const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);
    const infoId = add(`<< /Title (${esc(this.title)}) /Producer (Porch Pay) /CreationDate (D:${
      new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);

    let out = '%PDF-1.4\n';
    const offsets = [0];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++) {
      out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
           `startxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }
}

// HTML in, plain text out, keeping paragraph breaks so a letter still reads like one.
function htmlToBlocks(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n\n')
    .replace(/<\s*li\s*[^>]*>/gi, '  -  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split(/\n{2,}/).map(s => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
}

// A message or notice as a letter on the company's paper.
function letter({ company, subject, bodyHtml, bodyText, meta = [], sentAt, footer, logo }) {
  const d = new Doc({
    title: subject || 'Letter',
    footer: footer || `Sent through Porch Pay${sentAt ? ' · ' + String(sentAt).slice(0, 10) : ''}`,
  });
  d.letterhead(company, { logo });
  d.space(6);
  if (sentAt) d.text(new Date(sentAt.length <= 10 ? sentAt + 'T00:00:00Z' : sentAt + 'Z')
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
    { size: 9.5, gap: 8 });
  if (subject) d.text(subject, { size: 14, bold: true, gap: 10 });
  for (const [k, v] of meta) d.row(k, v, { size: 9.5 });
  if (meta.length) d.space(8);
  const blocks = bodyHtml ? htmlToBlocks(bodyHtml) : String(bodyText || '').split(/\n{2,}/);
  for (const b of blocks) d.text(b, { size: 10.5, gap: 5 }).space(5);
  return d.build();
}

module.exports = { Doc, letter, htmlToBlocks, wrap, textWidth, esc,
  prepareImage, decodePng, downscale, jpegInfo, PAGE, MARGIN, CONTENT_W };
