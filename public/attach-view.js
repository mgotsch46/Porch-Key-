// Photos and files on messages — one viewer for the staff web app, the staff phone page
// and the buyer portal, so a picture or a PDF looks and opens the same everywhere.
//
//   AttView.html(list)   thumbnails for [{id, filename, mime}]; drop into any innerHTML
//   AttView.open(g, i)   the full-screen viewer (wired up by html())
//
// Pictures show as pictures — iPhone HEIC included, which the server turns into a JPEG.
// A PDF shows its first page, and opens to every page drawn right here with pdf.js, so
// it reads the same in a browser, an iPhone and an Android phone (whose WebView cannot
// show a PDF on its own). Videos play in place. Nothing navigates away, so the store
// apps are never stranded on a file with no way back.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kind = (a) => {
    const m = String(a.mime || '').toLowerCase(), n = String(a.filename || '').toLowerCase();
    if (/^image\/(jpeg|jpg|png|gif|webp|bmp|heic|heif)$/.test(m) || /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/.test(n)) return 'img';
    if (m === 'application/pdf' || /\.pdf$/.test(n)) return 'pdf';
    if (/^video\//.test(m) || /\.(mp4|mov|webm|3gp)$/.test(n)) return 'video';
    if (/^audio\//.test(m) || /\.(mp3|m4a|amr|wav|aac|ogg)$/.test(n)) return 'audio';
    return 'file';
  };
  const viewUrl = (id) => `/api/documents/${id}/view`;
  const downloadUrl = (id) => `/api/documents/${id}/download`;
  const isNative = () => !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform());

  // Each html() call is one message's worth of files; the viewer steps through them.
  const GROUPS = new Map();
  let nextGroup = 0;

  function html(list) {
    const files = (list || []).filter((a) => a && a.id);
    const g = ++nextGroup;
    GROUPS.set(g, files);
    if (GROUPS.size > 400) GROUPS.delete(GROUPS.keys().next().value);
    return (list || []).map((a) => {
      if (!a || !a.id) return `<span class="av-file av-bad">⚠️ ${esc((a && a.filename) || 'Attachment missing')}</span>`;
      const i = files.indexOf(a);
      const open = `href="${viewUrl(a.id)}" onclick="AttView.open(${g},${i});return false"`;
      const name = esc(a.filename || 'File');
      switch (kind(a)) {
        case 'img':
          return `<a class="av-tile" ${open} title="${name}"><img loading="lazy" src="${viewUrl(a.id)}" alt="${name}"
            onerror="this.parentNode.classList.add('av-broken')"></a>`;
        case 'pdf':
          return `<a class="av-tile av-pdf" ${open} title="${name}"><span class="av-page" data-av-pdf="${a.id}"></span>
            <span class="av-cap">📄 ${name}</span></a>`;
        case 'video':
          return `<a class="av-tile av-vid" ${open} title="${name}"><video preload="metadata" muted playsinline
            src="${viewUrl(a.id)}#t=0.1"></video><span class="av-play">▶</span></a>`;
        case 'audio':
          return `<span class="av-file">🎧 ${name}<audio controls preload="none" src="${viewUrl(a.id)}"></audio></span>`;
        default:
          return `<a class="av-file" ${open}>📎 ${name}</a>`;
      }
    }).join('');
  }

  // ---------- pdf.js, loaded the first time a PDF is on screen ----------
  let pdfjsP = null;
  function pdfjs() {
    if (!pdfjsP) {
      pdfjsP = import('/vendor/pdfjs/pdf.min.js').then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
        return lib;
      });
      pdfjsP.catch(() => { pdfjsP = null; });
    }
    return pdfjsP;
  }
  async function openPdf(id) {
    const task = (await pdfjs()).getDocument({ url: viewUrl(id), withCredentials: true, isEvalSupported: false });
    const pdf = await task.promise;
    pdf.close = () => { try { task.destroy(); } catch (e) {} };   // frees the worker's copy
    return pdf;
  }
  async function drawPage(pdf, n, cssWidth) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: (cssWidth / base.width) * ratio });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = cssWidth + 'px'; c.style.height = Math.floor(vp.height / ratio) + 'px';
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  }

  // First-page thumbnails. Threads redraw often (the buyer's polls every 20 seconds), so
  // each PDF is drawn once and the picture reused.
  const THUMBS = new Map();
  async function thumb(el) {
    const id = Number(el.dataset.avPdf);
    el.dataset.avDone = '1';
    try {
      if (!THUMBS.has(id)) {
        THUMBS.set(id, (async () => {
          const pdf = await openPdf(id);
          const c = await drawPage(pdf, 1, 180);
          const pages = pdf.numPages;
          pdf.close();
          return { src: c.toDataURL('image/png'), pages };
        })());
      }
      const t = await THUMBS.get(id);
      el.innerHTML = `<img src="${t.src}" alt="">` + (t.pages > 1 ? `<span class="av-pages">${t.pages} pages</span>` : '');
    } catch (e) {
      console.warn('PDF preview failed', id, e);
      THUMBS.delete(id);
      el.classList.add('av-nopreview');
      el.textContent = 'PDF';
    }
  }
  function hydrate(root) {
    (root || document).querySelectorAll('[data-av-pdf]:not([data-av-done])').forEach(thumb);
  }
  new MutationObserver(() => hydrate()).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- the full-screen viewer ----------
  let cur = null;   // { files, i }
  function box() {
    let b = document.getElementById('av-box');
    if (b) return b;
    b = document.createElement('div');
    b.id = 'av-box';
    b.innerHTML = `<div class="av-bar"><span class="av-title"></span><span class="av-count"></span>
        <a class="av-btn av-dl" target="_blank" rel="noopener">Download</a>
        <button class="av-btn av-x" aria-label="Close">✕</button></div>
      <div class="av-body"></div>
      <button class="av-nav av-prev" aria-label="Previous">‹</button>
      <button class="av-nav av-next" aria-label="Next">›</button>`;
    document.body.appendChild(b);
    b.querySelector('.av-x').onclick = close;
    b.querySelector('.av-prev').onclick = () => step(-1);
    b.querySelector('.av-next').onclick = () => step(1);
    b.querySelector('.av-body').addEventListener('click', (e) => { if (e.target.classList.contains('av-body')) close(); });
    return b;
  }
  function open(g, i) {
    const files = GROUPS.get(g);
    if (!files || !files[i]) return;
    cur = { files, i };
    document.documentElement.classList.add('av-open');
    show();
  }
  function step(d) {
    if (!cur) return;
    const n = cur.i + d;
    if (n < 0 || n >= cur.files.length) return;
    cur.i = n; show();
  }
  function close() {
    const b = document.getElementById('av-box');
    if (b) { b.querySelectorAll('video,audio').forEach((m) => m.pause()); b.classList.remove('on'); b.querySelector('.av-body').innerHTML = ''; }
    document.documentElement.classList.remove('av-open');
    cur = null;
  }
  async function show() {
    const b = box(), a = cur.files[cur.i], body = b.querySelector('.av-body');
    b.classList.add('on');
    b.querySelector('.av-title').textContent = a.filename || 'File';
    b.querySelector('.av-count').textContent = cur.files.length > 1 ? `${cur.i + 1} of ${cur.files.length}` : '';
    // A download inside a store app would carry the whole app off to the file.
    const dl = b.querySelector('.av-dl');
    dl.href = downloadUrl(a.id); dl.style.display = isNative() ? 'none' : '';
    b.querySelector('.av-prev').style.visibility = cur.i > 0 ? 'visible' : 'hidden';
    b.querySelector('.av-next').style.visibility = cur.i < cur.files.length - 1 ? 'visible' : 'hidden';
    const k = kind(a);
    if (k === 'img') body.innerHTML = `<img class="av-full" src="${viewUrl(a.id)}" alt="${esc(a.filename || '')}">`;
    else if (k === 'video') body.innerHTML = `<video class="av-full" controls autoplay playsinline src="${viewUrl(a.id)}"></video>`;
    else if (k === 'audio') body.innerHTML = `<audio controls autoplay src="${viewUrl(a.id)}"></audio>`;
    else if (k === 'pdf') {
      body.innerHTML = '<div class="av-pdfpages"><p class="av-msg">Opening…</p></div>';
      const holder = body.firstChild, mine = cur;
      try {
        const pdf = await openPdf(a.id);
        if (cur !== mine) { pdf.close(); return; }
        holder.innerHTML = '';
        const w = Math.min(body.clientWidth - 24, 900);
        for (let n = 1; n <= pdf.numPages; n++) {
          if (cur !== mine || cur.files[cur.i] !== a) break;
          holder.appendChild(await drawPage(pdf, n, w));
        }
        pdf.close();
      } catch (e) {
        console.warn('PDF view failed', a.id, e);
        holder.innerHTML = `<p class="av-msg">This PDF could not be shown here.${isNative() ? '' :
          ` <a href="${downloadUrl(a.id)}">Download it</a> to open it.`}</p>`;
      }
    } else {
      body.innerHTML = `<p class="av-msg">${esc(a.filename || 'This file')} cannot be shown here.${isNative() ? '' :
        ` <a href="${downloadUrl(a.id)}">Download it</a> to open it.`}</p>`;
    }
  }
  document.addEventListener('keydown', (e) => {
    if (!cur) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  // ---------- looks ----------
  const css = document.createElement('style');
  css.textContent = `
  .av-tile{position:relative;display:block;align-self:flex-start;border-radius:14px;overflow:hidden;background:#F2F2F7;
    border:1px solid rgba(0,0,0,.08);line-height:0;cursor:pointer;text-decoration:none}
  .av-tile img,.av-tile video{display:block;max-width:220px;max-height:240px;min-width:60px;min-height:60px;object-fit:cover}
  .av-tile.av-broken::after{content:'Photo could not be shown';display:block;padding:14px;font-size:12px;line-height:1.3;color:#8E8E93}
  .av-tile.av-broken img{display:none}
  .av-pdf{width:180px;background:#fff}
  .av-page{display:flex;align-items:center;justify-content:center;width:180px;min-height:120px;max-height:240px;overflow:hidden;
    background:#F7F7F9;position:relative;color:#C7C7CC;font:700 20px/1 -apple-system,system-ui,sans-serif}
  .av-page img{width:180px;max-height:240px;object-fit:cover;object-position:top}
  .av-pages{position:absolute;right:6px;top:6px;background:rgba(0,0,0,.6);color:#fff;font-size:10.5px;line-height:1;padding:4px 6px;border-radius:8px}
  .av-cap{display:block;padding:7px 9px;font-size:12.5px;line-height:1.25;color:#1C1C1E;white-space:nowrap;overflow:hidden;
    text-overflow:ellipsis;border-top:1px solid rgba(0,0,0,.06);background:#fff}
  .av-vid .av-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:34px;color:#fff;
    text-shadow:0 1px 6px rgba(0,0,0,.5);pointer-events:none}
  .av-file{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 11px;border-radius:14px;background:#F2F2F7;
    border:1px solid rgba(0,0,0,.08);color:#1C1C1E;font-size:13px;text-decoration:none;max-width:280px;cursor:pointer}
  .av-file audio{width:230px;height:32px}
  .av-file.av-bad{color:#D70015;border-color:#FFB3B8;background:#fff;cursor:default}
  html.av-open{overflow:hidden}
  #av-box{position:fixed;inset:0;z-index:100000;background:rgba(8,8,10,.97);display:none;flex-direction:column}
  #av-box.on{display:flex}
  #av-box .av-bar{display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top) + 10px) 14px 10px;color:#fff;
    font:600 15px/1.3 -apple-system,system-ui,sans-serif}
  #av-box .av-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #av-box .av-count{color:#AEAEB2;font-weight:500;font-size:13px}
  #av-box .av-btn{background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:999px;padding:8px 14px;font:600 14px/1 inherit;
    text-decoration:none;cursor:pointer}
  #av-box .av-body{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;
    padding:8px 12px calc(env(safe-area-inset-bottom) + 12px);-webkit-overflow-scrolling:touch}
  #av-box .av-full{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
  #av-box .av-pdfpages{align-self:flex-start;display:flex;flex-direction:column;align-items:center;gap:10px;width:100%}
  #av-box .av-pdfpages canvas{background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.4);max-width:100%;height:auto!important}
  #av-box .av-msg{color:#E5E5EA;font:15px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:30px}
  #av-box .av-msg a{color:#8FD16B}
  #av-box .av-nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:64px;border:0;border-radius:12px;
    background:rgba(255,255,255,.12);color:#fff;font-size:34px;line-height:1;cursor:pointer}
  #av-box .av-prev{left:8px} #av-box .av-next{right:8px}`;
  document.head.appendChild(css);

  window.AttView = { html, open, close, hydrate, kind };
})();
