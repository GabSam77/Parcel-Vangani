/* =========================================================================
   Site Intelligence — report viewer
   1. Loads the master PDF (PF.config.reportPdf)
   2. Uses pdf-lib to copy only the pages for the chosen sections
   3. Adds a generated configuration page
   4. Renders the result with pdf.js into a custom viewer
   ========================================================================= */

(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const R = PF.report = {};
  let pdfjs = null, pdfDoc = null, bytes = null, builtKey = null, zoom = .4, toc = [], renderToken = 0, mainRenderTask = null;

  const abs = p => new URL(p, location.href).href;
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  async function libs() {
    if (!window.PDFLib) await loadScript(PF.config.vendor.pdflib);
    if (!pdfjs) {
      const inl = document.getElementById('pdfjs-src'), inlW = document.getElementById('pdfjs-worker-src');
      if (inl && inlW) {
        // single-file build: libraries are embedded in the page (works from file://)
        const blobUrl = t => URL.createObjectURL(new Blob([t.textContent], { type: 'text/javascript' }));
        pdfjs = await import(blobUrl(inl));
        pdfjs.GlobalWorkerOptions.workerSrc = blobUrl(inlW);
      } else {
        pdfjs = await import(abs(PF.config.vendor.pdfjs));
        pdfjs.GlobalWorkerOptions.workerSrc = abs(PF.config.vendor.pdfjsWorker);
      }
    }
  }

  /* Repair the old WeasyPrint font descriptor metrics found in some source
     reports. Only values far outside normal 1000-em units are changed. */
  function sanitizeMalformedFontMetrics(doc, { diagnostics = false, warn = true } = {}) {
    const { PDFName, PDFNumber, PDFArray, PDFDict } = PDFLib;
    const names = Object.fromEntries(['Type', 'FontDescriptor', 'Ascent', 'Descent', 'CapHeight', 'FontBBox'].map(k => [k, PDFName.of(k)]));
    let repaired = 0, repairedDescriptors = 0;
    const numberValue = value => value instanceof PDFNumber ? value.asNumber() : null;

    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const type = obj.get(names.Type);
      if (!(type instanceof PDFName) || type.asString() !== '/FontDescriptor') continue;
      const changed = [];

      for (const key of ['Ascent', 'Descent', 'CapHeight']) {
        const current = obj.get(names[key]), value = numberValue(current);
        if (value === null || Math.abs(value) <= 10000) continue;
        const fixed = value / 1000;
        obj.set(names[key], PDFNumber.of(fixed));
        repaired++;
        changed.push(`${key} ${value} -> ${fixed}`);
      }

      const bbox = obj.get(names.FontBBox);
      const resolved = bbox && doc.context.lookup(bbox);
      if (resolved instanceof PDFArray && resolved.size() === 4) {
        const yChanges = [];
        for (const index of [1, 3]) {
          const current = resolved.get(index), value = numberValue(current);
          if (value === null || Math.abs(value) <= 10000) continue;
          const fixed = value / 1000;
          resolved.set(index, PDFNumber.of(fixed));
          repaired++;
          yChanges.push(`${index === 1 ? 'yMin' : 'yMax'} ${value} -> ${fixed}`);
        }
        if (yChanges.length) changed.push(`FontBBox ${yChanges.join(', ')}`);
      }
      if (changed.length) repairedDescriptors++;
      if (diagnostics && changed.length) {
        console.debug(`Repaired malformed FontDescriptor: ${changed.join('; ')}`);
      }
    }
    if (warn && repaired) console.warn(`Repaired ${repairedDescriptors} malformed FontDescriptor(s) (${repaired} metric value(s)).`);
    return repairedDescriptors;
  }

  /* WinAnsi-safe text for the standard Helvetica font */
  const safe = s => String(s).replace(/₹/g, 'Rs ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[^\x20-\x7E·°]/g, '');

  async function assemble() {
    const st = PF.state, cfg = PF.config;
    let buf;
    if (PF.inlinePdf) buf = Uint8Array.from(atob(PF.inlinePdf), ch => ch.charCodeAt(0)); // single-file build
    else {
      const res = await fetch(cfg.reportPdf);
      if (!res.ok) throw new Error(`Couldn't find ${cfg.reportPdf} (HTTP ${res.status}).`);
      buf = await res.arrayBuffer();
    }
    const src = await PDFLib.PDFDocument.load(buf);
    const n = src.getPageCount(), valid = p => p >= 1 && p <= n;

    const order = [], entries = [];
    const push = (pages, label, num) => {
      const ok = pages.filter(valid); if (!ok.length) return;
      entries.push({ label, num, start: order.length }); order.push(...ok);
    };
    push(cfg.alwaysFirst, 'Cover & contents', '00');
    push(cfg.summaryPages || [], 'Executive summary', 'ES');
    PF.sections.filter(s => st.sections.has(s.id)).forEach(s => push(cfg.sectionPages[s.id] || [], s.title.split(' — ')[0], s.num));
    push(cfg.alwaysLast, 'Methodology', '–');

    const out = await PDFLib.PDFDocument.create();
    const copied = await out.copyPages(src, order.map(p => p - 1));
    copied.forEach(p => out.addPage(p));

    const reg = await out.embedFont(PDFLib.StandardFonts.Helvetica), bold = await out.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const rgb = c => PDFLib.rgb(c[0], c[1], c[2]);
    const H = p => p.getHeight();
    const outIndexOf = srcPage => order.indexOf(srcPage);
    const chosen = PF.sections.filter(s => st.sections.has(s.id));

    /* 1. generated A4 configuration page; source pages remain untouched. */
    const cs = cfg.configurationPage || {};
    if (cs.enabled !== false) {
      const page = out.addPage([595.28, 841.89]);
      const cat = PF.taxonomy.find(t => t.id === st.category);
      const d = new Date(), date = `${d.getDate()} ${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getMonth()]} ${d.getFullYear()}`;
      const x = 48, width = 499, top = 770, accent = cs.accent || [0.63, 0.14, 0.17];
      page.drawText('REPORT CONFIGURATION', { x, y: top, size: 13, font: bold, color: rgb(accent) });
      page.drawLine({ start: { x, y: top - 12 }, end: { x: x + width, y: top - 12 }, thickness: 0.8, color: rgb(accent) });
      const rows = [
        ['ASSET TYPE', `${st.subtype} (${cat ? cat.name : ''})`],
        ['SECTIONS', chosen.map(x => `${x.num} ${x.short}`).join('   ')],
        ['LOCATION', st.location.confirmed ? `${st.location.latitude.toFixed(6)}, ${st.location.longitude.toFixed(6)}  (${({ map: 'map selection', link: 'Google Maps link', coordinates: 'coordinates' })[st.location.source] || ''})` : 'Not set'],
        ['LAND BOUNDARY', st.boundary.defined ? `Approx. ${Math.round(st.boundary.area).toLocaleString('en-IN')} m2 / ${st.boundary.areaAcres.toFixed(2)} acres (mapped, not surveyed)` : PF.loc.mode() === 'not_applicable' ? 'Not required for this property type' : 'Not defined'],
        ['GENERATED', `${date}  ·  Ref ${st.ref}`],
      ];
      rows.forEach(([k, v], i) => {
        const y = top - 42 - i * 38;
        page.drawText(k, { x, y, size: 8, font: bold, color: rgb(cs.labelColor || [0.54, 0.58, 0.64]) });
        page.drawText(safe(v) || '—', { x: x + 112, y, size: 10, font: reg, color: rgb(cs.color || [0.17, 0.20, 0.27]), maxWidth: width - 112 });
      });
      entries.push({ label: 'Report configuration', num: 'INFO', start: out.getPageCount() - 1 });
    }

    /* 2. contents page: fade out the rows for sections that were not chosen */
    const ct = cfg.contents;
    const ctIdx = ct && ct.enabled && cfg.templateId && ct.templateId === cfg.templateId ? outIndexOf(ct.page) : -1;
    if (ctIdx >= 0) {
      const page = out.getPage(ctIdx), h = H(page);
      Object.entries(ct.rows).forEach(([id, [top, bottom]]) => {
        if (st.sections.has(id)) return;
        page.drawRectangle({ x: ct.x0, y: h - bottom, width: ct.x1 - ct.x0, height: bottom - top, color: PDFLib.rgb(1, 1, 1), opacity: 0.82 });
        const label = 'NOT INCLUDED IN THIS REPORT';
        page.drawText(label, { x: ct.labelX, y: ct.labelAtBottom ? h - bottom + 7 : h - top - 13, size: 6.5, font: bold, color: rgb(ct.labelColor) });
      });
    }

    /* 3. footers: renumber "Page X of Y" for the assembled report */
    const pn = cfg.pageNumbers;
    if (pn && pn.enabled && cfg.templateId && pn.templateId === cfg.templateId) {
      const total = out.getPageCount();
      out.getPages().slice(0, order.length).forEach((page, i) => {
        if (pn.skip.includes(order[i])) return;
        const [rx, ry, rw, rh] = pn.cover;
        page.drawRectangle({ x: rx, y: ry, width: rw, height: rh, color: PDFLib.rgb(1, 1, 1) });
        const text = `Page ${i + 1} of ${total}`;
        page.drawText(text, { x: pn.right - reg.widthOfTextAtSize(text, pn.size), y: pn.y, size: pn.size, font: reg, color: rgb(pn.color) });
      });
    }
    out.setTitle(safe(`Land Parcel Feasibility Report - ${st.subtype} - ${st.ref}`));
    out.setAuthor('HDFC Capital');
    sanitizeMalformedFontMetrics(out, { diagnostics: cfg.pdfDiagnostics === true });
    bytes = await out.save();
    // Verify the serialized bytes. If serialization/import changed the object
    // graph, repair the parsed output and serialize once more.
    let serialized = await PDFLib.PDFDocument.load(bytes);
    if (sanitizeMalformedFontMetrics(serialized, { diagnostics: false, warn: false })) {
      bytes = await serialized.save();
      serialized = await PDFLib.PDFDocument.load(bytes);
    }
    if (hasMalformedFontMetrics(serialized)) throw new Error('Malformed font metrics remain in the generated PDF.');
    toc = entries;
  }

  function hasMalformedFontMetrics(doc) {
    const { PDFName, PDFNumber, PDFArray, PDFDict } = PDFLib;
    const typeKey = PDFName.of('Type'), descriptorName = PDFName.of('FontDescriptor');
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const type = obj.get(typeKey);
      if (!(type instanceof PDFName) || type.asString() !== '/FontDescriptor') continue;
      for (const key of ['Ascent', 'Descent', 'CapHeight']) {
        const n = obj.get(PDFName.of(key));
        if (n instanceof PDFNumber && Math.abs(n.asNumber()) > 10000) return true;
      }
      const bbox = doc.context.lookup(obj.get(PDFName.of('FontBBox')));
      if (bbox instanceof PDFArray) for (const i of [1, 3]) {
        const n = bbox.get(i);
        if (n instanceof PDFNumber && Math.abs(n.asNumber()) > 10000) return true;
      }
    }
    return false;
  }

  async function renderPages() {
    const token = ++renderToken;
    if (mainRenderTask) { try { mainRenderTask.cancel(); } catch (_) {} mainRenderTask = null; }
    const wrap = $('#rvPages');
    wrap.innerHTML = '';
    const first = await pdfDoc.getPage(1);
    const vw = first.getViewport({ scale: 1 }).width;
    const avail = Math.min(880, wrap.clientWidth - 32);
    const scale = (avail / vw) * zoom, dpr = Math.min(devicePixelRatio || 1, 2);
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (token !== renderToken) return;
      const page = await pdfDoc.getPage(i), vp = page.getViewport({ scale: scale * dpr });
      const div = document.createElement('div'); div.className = 'rv-page-wrap'; div.dataset.page = i;
      div.style.animationDelay = Math.min(i, 6) * 60 + 'ms';
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      c.style.width = vp.width / dpr + 'px'; c.style.height = vp.height / dpr + 'px';
      div.appendChild(c); wrap.appendChild(div);
      const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
      mainRenderTask = task;
      try { await task.promise; }
      catch (err) { if (token !== renderToken || err && err.name === 'RenderingCancelledException') return; throw err; }
      if (mainRenderTask === task) mainRenderTask = null;
    }
    observePages();
  }

  async function renderThumbs() {
    const t = $('#rvThumbs'); if (!t) return; t.innerHTML = '';
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i), vp = page.getViewport({ scale: .22 });
      const b = document.createElement('button'); b.dataset.page = i; b.setAttribute('aria-label', 'Go to page ' + i);
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      c.style.width = vp.width + 'px'; c.style.height = vp.height + 'px';
      b.appendChild(c); b.insertAdjacentHTML('beforeend', `<span>${i}</span>`); t.appendChild(b);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    }
  }

  function renderToc() {
    $('#rvToc').innerHTML = toc.map(e => `<li><button data-page="${e.start + 1}"><span class="mono">${e.num}</span><span>${e.label}</span><span class="pg">p.${e.start + 1}</span></button></li>`).join('');
  }

  function goPage(n) { const el = $(`#rvPages [data-page="${n}"]`); if (el) $('#rvPages').scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' }); }

  let io;
  function observePages() {
    io && io.disconnect();
    const vis = new Map();
    io = new IntersectionObserver(es => {
      es.forEach(e => vis.set(+e.target.dataset.page, e.intersectionRatio));
      let best = 1, r = -1; vis.forEach((v, k) => { if (v > r) { r = v; best = k; } });
      $('#rvPage').textContent = `${best} / ${pdfDoc.numPages}`;
      $$('#rvThumbs button').forEach(b => b.classList.toggle('is-active', +b.dataset.page === best));
      let cur = toc[0]; toc.forEach(t => { if (t.start + 1 <= best) cur = t; });
      $$('#rvToc button').forEach(b => b.classList.toggle('is-active', cur && +b.dataset.page === cur.start + 1));
    }, { root: $('#rvPages'), threshold: [0, .25, .5, .75, 1] });
    $$('#rvPages .rv-page-wrap').forEach(p => io.observe(p));
  }

  function showError(msg) {
    $('#rvPages').innerHTML = `<div class="rv-error"><p><b>We couldn't build the PDF.</b></p><p>${msg}</p><p class="mono" style="font-size:12px">If you opened index.html directly from disk, start a local server instead (see README, step 2).</p></div>`;
  }

  async function build() {
    const st = PF.state;
    const key = [st.ref, st.subtype, [...st.sections].join(','), st.location.latitude, st.location.longitude, st.boundary.defined ? st.boundary.area : 'nb'].join('|');
    const cat = PF.taxonomy.find(t => t.id === st.category);
    $('#rvRef').textContent = `${st.ref} · ${cat ? cat.name.toUpperCase() : ''}`;
    $('#rvTitle').textContent = `${st.subtype} · ${st.site.label}`;
    if (key === builtKey && pdfDoc) return;
    $('#rvPages').innerHTML = '<div class="rv-loading"><span class="spinner"></span>Assembling your PDF…</div>';
    $('#rvToc').innerHTML = '';
    try {
      await libs();
      await assemble();
      pdfDoc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      builtKey = key; zoom = .4; $('#zVal').textContent = '40%';  // opens at 40% so the whole page is in view
      renderToc();
      await renderPages();
      renderThumbs();
    } catch (err) {
      console.error(err); showError(err.message || String(err));
    }
  }

  R.init = () => {
    const framed = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
    const dl = $('#rvDownload');
    const fileName = () => `${PF.config.downloadName || 'Site-Report'}-${PF.state.ref}.pdf`;
    let saver = null; // claude.ai "downloads" capability when the page runs as a hosted artifact
    if (framed) {
      dl.hidden = true;
      if (window.claude && window.claude.use) window.claude.use('downloads').then(d => { if (d) { saver = d; dl.hidden = false; } }).catch(() => {});
    }
    dl.addEventListener('click', async () => {
      if (!bytes) return;
      if (saver) {
        try { await saver.save({ filename: fileName(), data: new Blob([bytes], { type: 'application/pdf' }) }); PF.toast('PDF saved'); }
        catch (e) { if (e && e.code === 'declined') return; if (e && /unavailable|not_granted|capability/.test(e.code || '')) { dl.hidden = true; PF.toast('Downloads aren\u2019t available in this view'); } else PF.toast('Couldn\u2019t save the PDF. Try again.'); }
        return;
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a'); a.href = url; a.download = fileName(); document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      PF.toast('PDF downloaded');
    });
    const setZoom = z => { zoom = Math.max(.25, Math.min(2, z)); $('#zVal').textContent = Math.round(zoom * 100) + '%'; if (pdfDoc) renderPages(); };
    $('#zIn').addEventListener('click', () => setZoom(zoom + .15));
    $('#zOut').addEventListener('click', () => setZoom(zoom - .15));
    $('#rvToc').addEventListener('click', e => { const b = e.target.closest('button'); if (b) goPage(+b.dataset.page); });
    let rt; addEventListener('resize', () => { if (document.body.dataset.route !== 'report' || !pdfDoc) return; clearTimeout(rt); rt = setTimeout(renderPages, 250); });
  };
  R.bytes = () => bytes;
  R.sanitizeMalformedFontMetrics = sanitizeMalformedFontMetrics;
  R.onShow = () => { build(); };
  document.addEventListener('click', e => {
    if (e.target.closest('#rvEditLoc')) { PF.state.step = 2; PF.go('build'); }
    if (e.target.closest('#rvNew')) {
      // start a fresh report at step 1 (property type) instead of going back to the home page
      const st = PF.state; st.category = null; st.subtype = null; st.sections = new Set(); st.generated = false; st.step = 1; st.ref = null;
      PF.loc.initState(); PF._suggestSite = null; PF.go('build');
    }
    if (e.target.closest('#rvExplore')) { PF._focusProperty = true; PF.go('explore'); }
  });
})();
