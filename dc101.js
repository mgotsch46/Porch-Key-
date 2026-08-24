// Michigan's forfeiture notice — SCAO form DC 101 — filled by the server, on the
// official form, with zero dependencies.
//
// How: assets/dc101-template.pdf is the real form from courts.michigan.gov,
// pre-flattened at build time (tools/build-dc101-map.py) with Liberation Sans fully
// embedded. Filling is an *incremental update* — the template bytes are untouched and
// a short tail is appended: two redefined page objects that splice in an overlay
// content stream, the overlays themselves, an xref and a trailer. Every object number
// and rewritten dictionary was computed at build time and lives in dc101-map.json, so
// this file does no PDF parsing at all. It measures text, escapes it, and places it
// at the rectangles the form's own fields occupied.
//
// Two renders per serving, on purpose:
//   buyerCopy  — notice page filled, certificate of service left blank. This is what
//                Lob prints and mails; the certificate is the court's business.
//   courtCopy  — same, plus the certificate of service completed with the certified
//                mail tracking number. Filed on the loan as the exhibit for DC 102.
//
// Statutory floor: MCL 600.5726/.5728 — the cure period is 15 days unless the
// contract grants longer, and service by first-class mail is authorized. Certified is
// first-class with proof stapled on.

const fs = require('fs');
const path = require('path');

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'dc101-map.json'), 'utf8'));
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'assets', 'dc101-template.pdf'));
if (TEMPLATE.length !== MAP.templateBytes) {
  throw new Error('dc101-template.pdf does not match dc101-map.json — re-run tools/build-dc101-map.py');
}

// ---------- text ----------
// WinAnsi is close enough to latin-1 for names, addresses and dollar amounts; the
// few typographic characters people paste in are folded to their plain forms.
const FOLD = { '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '…': '...', ' ': ' ' };
function winAnsi(s) {
  let out = '';
  for (const ch of String(s)) {
    const f = FOLD[ch];
    if (f) { out += f; continue; }
    const c = ch.codePointAt(0);
    out += (c >= 32 && c <= 255 && c !== 127) ? ch : '?';
  }
  return out;
}
const escText = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
function textWidth(s, size) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += (MAP.widths[(c >= 32 && c <= 255 ? c : 63) - 32] || 500);
  }
  return (w / 1000) * size;
}

// ---------- placement ----------
// Text runs are laid from the top of the field's rectangle downward, which makes a
// one-line field and the two-line address box the same code. If a line is wider than
// its box the font shrinks (never below 6pt), and past that it truncates with an
// ellipsis rather than invading the neighbouring column.
function fieldOps(name, value) {
  const f = MAP.fields[name];
  if (!f) throw new Error(`DC 101 has no field "${name}"`);
  const [x0, y0, x1, y1] = f.rect;
  if (f.type === '/Btn') {
    if (!value) return '';
    const size = (y1 - y0) + 1;
    return `BT /PPF ${size.toFixed(1)} Tf 1 0 0 1 ${(x0 + 0.5).toFixed(1)} ${(y0 + 1).toFixed(1)} Tm (X) Tj ET\n`;
  }
  const text = winAnsi(String(value)).trim();
  if (!text) return '';
  const maxW = (x1 - x0) - 3;
  const lines = text.split('\n');
  let ops = '';
  let y = y1 - 9.2;                                  // first baseline, from the top
  for (let line of lines) {
    if (y < y0 - 1) break;                           // no room for more lines
    let size = 9;
    while (size > 6 && textWidth(line, size) > maxW) size -= 0.5;
    if (textWidth(line, size) > maxW) {
      while (line.length > 1 && textWidth(line + '...', size) > maxW) line = line.slice(0, -1);
      line += '...';
    }
    ops += `BT /PPF ${size} Tf 1 0 0 1 ${(x0 + 1.5).toFixed(1)} ${y.toFixed(1)} Tm (${escText(line)}) Tj ET\n`;
    y -= 11;
  }
  return ops;
}

// ---------- assembly ----------
const pad10 = (n) => String(n).padStart(10, '0');

function render(values) {
  const perPage = ['', ''];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    const f = MAP.fields[name];
    if (!f) throw new Error(`DC 101 has no field "${name}"`);
    perPage[f.page] += fieldOps(name, value);
  }

  const chunks = [TEMPLATE];
  const offsets = {};                                 // objNum -> byte offset
  let pos = TEMPLATE.length;
  const push = (objNum, body) => {
    offsets[objNum] = pos;
    const b = Buffer.from(`${objNum} 0 obj\n${body}\nendobj\n`, 'latin1');
    chunks.push(b); pos += b.length;
  };

  for (const pg of MAP.pages) push(pg.objNum, pg.rewrittenDict);
  push(MAP.saveObjNum, `<< /Length 1 >>\nstream\nq\nendstream`);
  MAP.overlayObjNums.forEach((objNum, i) => {
    const s = `Q q 0 0 0 rg\n${perPage[i]}Q`;
    push(objNum, `<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });

  // Classic xref with one subsection per run of consecutive object numbers.
  const nums = Object.keys(offsets).map(Number).sort((a, b) => a - b);
  let xref = 'xref\n';
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) xref += `${pad10(offsets[nums[k]])} 00000 n \n`;
    i = j + 1;
  }
  const trailer = `trailer\n<< /Size ${MAP.newSize} /Root ${MAP.rootObjNum} 0 R` +
    (MAP.infoObjNum ? ` /Info ${MAP.infoObjNum} 0 R` : '') +
    ` /Prev ${MAP.lastXref} >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(chunks);
}

// ---------- from loan data to form values ----------
const money = (c) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function usDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
}

// One object of everything the form wants, computed from what the app knows. The
// server passes this to the review modal so nothing is mailed sight unseen.
function buildValues({ company, property, tenant, missedDueDates, pastDueCents,
                       courtDistrict, courtAddress, courtPhone, contractDate,
                       cureDays, feesCents, signerName, serviceDate }) {
  // The seller on a PorchPay deal is the property's trust; the company is the
  // fallback for a house held directly.
  const sellers = (property && property.trust_name) || (company && (company.mgmt_company_name || company.name)) || '';
  const sellers2 = (property && property.trust_name && property.trustee) ? `by ${property.trustee}, trustee` : '';
  const premises1 = property ? `${property.address}, ${property.city}, ${property.state} ${property.zip}` : '';
  const v = {
    'judicial district': courtDistrict || '',
    'court address': courtAddress || '',
    'court telephone no': courtPhone || '',
    'land contract date': usDate(contractDate),
    'land contract seller or selllers names line 1': sellers,
    'land contract seller or selllers names line 2': sellers2,
    'land contract purchaser or purchasers names': (tenant && tenant.name) || '',
    'address or legal description of the premises line 1': premises1,
    'demanded by name': sellers,
    'seller': true,
    'sum amount': money(pastDueCents),
    'payments due dates': (missedDueDates || []).map(usDate).join(', '),
    'cured or paid within days': String(cureDays || 15),
    'date': usDate(serviceDate),
    'signature': signerName || '',
  };
  if (feesCents > 0) {
    v['amount other'] = true;
    v['other amount'] = money(feesCents);
    v['other amount description'] = 'late fees and costs due under the contract';
  }
  return v;
}

// The certificate of service, completed after Lob accepts the letter — this render is
// the court copy. Service by certified mail is first-class mail with proof, so the
// form's own "by first-class mail" box is the right one; the tracking number goes on
// the place-of-service line where a judge will look for it.
function certificateValues({ tenant, property, mailedAt, tracking, signerName }) {
  const addr = property ? `${property.address}, ${property.city}, ${property.state} ${property.zip}` : '';
  return {
    'I served': true,
    'by first class mail': true,
    'certificate of service name': (tenant && tenant.name) || 'Occupant',
    'certificate of service date and time': usDate(mailedAt),
    'certificate of service place or address':
      `${addr}\nby USPS Certified Mail, tracking no. ${tracking || '(pending)'}`,
    'certificate of service signature': signerName || '',
    'certificate of service name2': signerName || '',
  };
}

module.exports = { render, buildValues, certificateValues, fieldNames: Object.keys(MAP.fields) };
