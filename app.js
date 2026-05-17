// app.js — UI logic, vault state, auto-lock, clipboard, import/export.
(() => {
  'use strict';

  // ---------- PIN entry component (iOS-style numpad) ----------
  const PIN_LENGTH = 6;
  const PIN_LETTERS = { 1:'', 2:'ABC', 3:'DEF', 4:'GHI', 5:'JKL', 6:'MNO', 7:'PQRS', 8:'TUV', 9:'WXYZ', 0:'' };
  function haptic(ms = 8){ try { navigator.vibrate && navigator.vibrate(ms); } catch {} }
  function pinKeyHTML(n){
    const letters = PIN_LETTERS[n];
    return `<button type="button" class="pin-key" data-d="${n}">
      <span class="digit">${n}</span>
      ${letters ? `<span class="letters">${letters}</span>` : `<span class="letters-spacer"></span>`}
    </button>`;
  }
  function createPinEntry(host, onComplete){
    host.innerHTML = `
      <div class="pin-dots" id="${host.id}-dots"></div>
      <div class="pin-pad">
        ${[1,2,3,4,5,6,7,8,9].map(pinKeyHTML).join('')}
        <button type="button" class="pin-key empty" tabindex="-1"></button>
        ${pinKeyHTML(0)}
        <button type="button" class="pin-key del" data-act="del" aria-label="Delete">
          <svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 13.59L17.59 18 14 14.41 10.41 18 9 16.59 12.59 13 9 9.41 10.41 8 14 11.59 17.59 8 19 9.41 15.41 13 19 16.59z"/></svg>
        </button>
      </div>`;
    const dotsEl = host.querySelector('.pin-dots');
    let value = '';
    let busy = false;
    function renderDots(){
      dotsEl.innerHTML = Array.from({length: PIN_LENGTH}, (_, i) =>
        `<span class="pin-dot${i < value.length ? ' filled' : ''}"></span>`).join('');
    }
    renderDots();
    function add(d){
      if (busy || value.length >= PIN_LENGTH) return;
      haptic(8);
      value += d; renderDots();
      if (value.length === PIN_LENGTH){
        busy = true;
        Promise.resolve(onComplete(value)).finally(() => { busy = false; });
      }
    }
    function back(){
      if (busy || !value.length) return;
      haptic(6);
      value = value.slice(0, -1); renderDots();
    }
    host.addEventListener('click', (e) => {
      const k = e.target.closest('.pin-key');
      if (!k) return;
      if (k.dataset.act === 'del') back();
      else if (k.dataset.d != null) add(k.dataset.d);
    });
    const keyHandler = (e) => {
      if (!host.isConnected || host.offsetParent === null) return;
      if (/^[0-9]$/.test(e.key)) { add(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { back(); e.preventDefault(); }
    };
    document.addEventListener('keydown', keyHandler);
    return {
      clear(){ value = ''; busy = false; renderDots(); },
      getValue(){ return value; },
      shake(){
        haptic(40);
        dotsEl.classList.remove('shake');
        void dotsEl.offsetWidth;
        dotsEl.classList.add('shake');
      },
    };
  }

  // ---------- State ----------
  const State = {
    key: null,          // CryptoKey (master), kept only in memory
    salt: null,         // Uint8Array
    iterations: Crypto.KDF_ITERATIONS,
    vault: null,        // { version, entries: [...] }
    selectedId: null,
    filter: { query: '', category: 'all' },
    prefs: { autoLockMin: 5, clipClearSec: 20, theme: 'auto', userCats: [] },
    idleTimer: null,
    clipTimer: null,
    lastClip: '',
  };

  // ---------- Theme ----------
  function applyTheme(t){
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('cred-theme', t || 'auto'); } catch {}
    State.prefs.theme = t || 'auto';
    // Reflect active state in any rendered segmented control
    document.querySelectorAll('[data-theme-pick]').forEach(b => {
      b.classList.toggle('active', b.dataset.themePick === (t || 'auto'));
    });
  }
  // Initialize from localStorage (pre-paint script already set data-theme; this syncs State)
  (function bootTheme(){
    let saved = null;
    try { saved = localStorage.getItem('cred-theme'); } catch {}
    State.prefs.theme = saved || 'auto';
  })();

  // ---------- Helpers ----------
  const $  = (id) => document.getElementById(id);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function showScreen(id){
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  }

  // Smoothly transition from the currently-active screen to another screen.
  // Plays an exit animation on the current screen, then swaps. Returns a promise.
  async function transitionToScreen(id){
    const current = document.querySelector('.screen.active');
    if (current && current.id !== id){
      current.classList.add('exiting');
      await sleep(260);
      current.classList.remove('exiting');
    }
    showScreen(id);
  }

  function toast(msg, ms=1800){
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.hidden = true, ms);
  }

  const MODAL_CLOSE_MS = 240;
  function openModal(id){
    const m = $(id);
    if (!m) return;
    m.classList.remove('closing');
    m.hidden = false;
  }
  function closeModal(id){
    const m = typeof id === 'string' ? $(id) : id;
    if (!m || m.hidden) return;
    m.classList.add('closing');
    setTimeout(() => {
      m.hidden = true;
      m.classList.remove('closing');
    }, MODAL_CLOSE_MS);
  }

  function escapeHTML(s){
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function initials(s){
    s = (s || '?').trim();
    const parts = s.split(/\s+/).slice(0, 2);
    return parts.map(p => p[0]?.toUpperCase() || '').join('') || '?';
  }

  function hueFor(s){
    let h = 0;
    for (const c of s || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 360;
  }

  function avatarStyle(title){
    const h = hueFor(title);
    return `background:linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h+40)%360} 70% 45%))`;
  }

  function domainOf(url){
    if (!url) return null;
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url);
      return u.hostname.replace(/^www\./, '');
    } catch { return null; }
  }
  function faviconURL(url){
    const d = domainOf(url);
    return d ? `https://icons.duckduckgo.com/ip3/${d}.ico` : null;
  }
  function avatarHTML(entry){
    const fav = faviconURL(entry.url);
    const i = escapeHTML(initials(entry.title));
    const t = escapeHTML(entry.title || '?');
    if (fav){
      return `<div class="avatar avatar-img" data-title="${t}" data-init="${i}">
        <img src="${escapeHTML(fav)}" alt="" referrerpolicy="no-referrer" loading="lazy" />
      </div>`;
    }
    return `<div class="avatar" style="${avatarStyle(entry.title)}">${i}</div>`;
  }
  // Replace failed favicon images with the initials avatar
  function wireFaviconFallback(root){
    (root || document).querySelectorAll('.avatar-img img').forEach(img => {
      img.addEventListener('error', () => {
        const av = img.parentElement;
        if (!av) return;
        const title = av.getAttribute('data-title') || '?';
        av.classList.remove('avatar-img');
        av.removeAttribute('style');
        av.style.cssText = avatarStyle(title);
        av.innerHTML = av.getAttribute('data-init') || '?';
      }, { once: true });
    });
  }
  function normalizeURL(url){
    if (!url) return '';
    return /^[a-z]+:\/\//i.test(url) ? url : 'https://' + url;
  }

  function setStrengthMeter(meterEl, score){
    meterEl.className = 'strength ' + (['','weak','fair','good','strong'][score] || '');
    meterEl.querySelector('div').style.width = (score * 25) + '%';
  }

  function bindStrength(inputId, meterId, hintId){
    const i = $(inputId), m = $(meterId), h = hintId ? $(hintId) : null;
    if (!i) return;
    i.addEventListener('input', () => {
      const s = Crypto.strengthScore(i.value);
      setStrengthMeter(m, s);
      if (h) h.textContent = ['','Weak','Fair','Good','Strong'][s] || '';
    });
  }

  // ---------- Persistence ----------
  async function loadMeta(){
    const meta = await DB.get('meta');     // { salt, iterations, hasVault, prefs }
    if (!meta) return null;
    return meta;
  }

  async function loadEncryptedVault(){
    return await DB.get('vault');          // { iv: Uint8Array, ct: Uint8Array }
  }

  async function saveVault(){
    if (!State.key) throw new Error('locked');
    const { iv, ct } = await Crypto.encryptJSON(State.key, State.vault);
    await DB.put('vault', { iv, ct });
    const meta = (await DB.get('meta')) || {};
    meta.salt = State.salt;
    meta.iterations = State.iterations;
    meta.hasVault = true;
    meta.prefs = State.prefs;
    await DB.put('meta', meta);
  }

  async function persistPrefs(){
    const meta = (await DB.get('meta')) || {};
    meta.prefs = State.prefs;
    await DB.put('meta', meta);
  }

  // ---------- Auto-lock ----------
  function resetIdle(){
    clearTimeout(State.idleTimer);
    if (!State.key) return;
    const ms = Math.max(1, State.prefs.autoLockMin) * 60_000;
    State.idleTimer = setTimeout(lock, ms);
  }
  ['mousemove','keydown','touchstart','click','scroll'].forEach(ev => {
    document.addEventListener(ev, resetIdle, { passive: true });
  });

  // Lock instantly when the app goes to the background (like real password managers).
  let _bgAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden){ _bgAt = Date.now(); return; }
    if (!State.key) return;
    const gone = Date.now() - _bgAt;
    const threshold = (State.prefs.bgLockSec ?? 15) * 1000;
    if (gone >= threshold) lock();
    else resetIdle();
  });
  window.addEventListener('pagehide', () => { if (State.key) _bgAt = Date.now(); });

  function lock(){
    State.key = null;
    State.vault = null;
    State.selectedId = null;
    clearTimeout(State.idleTimer);
    clearClipboardSoon(true);
    mountUnlock();
    showScreen('screen-lock');
  }

  // ---------- Clipboard ----------
  async function copyAndClear(text, label){
    try {
      await navigator.clipboard.writeText(text);
      State.lastClip = text;
      toast(`${label || 'Copied'} • clears in ${State.prefs.clipClearSec}s`);
      clearTimeout(State.clipTimer);
      State.clipTimer = setTimeout(async () => {
        try {
          const cur = await navigator.clipboard.readText().catch(() => '');
          if (cur === State.lastClip) await navigator.clipboard.writeText('');
        } catch { /* clipboard read may be blocked — silently ignore */ }
        State.lastClip = '';
      }, State.prefs.clipClearSec * 1000);
    } catch {
      // Fallback for iOS Safari when not in a user gesture context
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed'); }
      ta.remove();
    }
  }

  function clearClipboardSoon(immediate){
    if (immediate){ clearTimeout(State.clipTimer); State.lastClip=''; return; }
  }

  // ---------- Vault rendering ----------
  function categories(){
    const m = new Map();
    for (const e of State.vault.entries){
      const c = (e.category || 'Login').trim() || 'Login';
      m.set(c, (m.get(c) || 0) + 1);
    }
    return [...m.entries()].sort((a,b) => a[0].localeCompare(b[0]));
  }

  function renderCategories(){
    const favCount = State.vault.entries.filter(e => e.favorite).length;
    const all = State.vault.entries.length;
    const cats = categories();

    // Sidebar (desktop)
    const html = [
      cat('all', 'All items', all),
      cat('__fav__', 'Favorites', favCount),
      `<div class="sect" style="padding:8px 10px 4px">Categories</div>`,
      ...cats.map(([n,c]) => cat(n, n, c)),
    ].join('');
    $('cats').innerHTML = html;
    $$('.cat', $('cats')).forEach(el => el.addEventListener('click', () => {
      setCategory(el.dataset.cat);
      $('sidebar').classList.remove('open');
    }));

    // Chips (mobile)
    const chipsHtml = [
      chip('all', 'All', all),
      ...(favCount > 0 ? [chip('__fav__', '★ Favorites', favCount)] : []),
      ...cats.map(([n,c]) => chip(n, n, c)),
    ].join('');
    $('chips').innerHTML = chipsHtml;
    $$('.chip', $('chips')).forEach(el => el.addEventListener('click', () => {
      setCategory(el.dataset.cat);
    }));

    function chip(id, label, count){
      const active = State.filter.category === id ? ' active' : '';
      return `<button type="button" class="chip${active}" data-cat="${escapeHTML(id)}">${escapeHTML(label)}<span class="count">${count}</span></button>`;
    }

    function cat(id, label, count){
      const active = State.filter.category === id ? ' active' : '';
      return `<div class="cat${active}" data-cat="${escapeHTML(id)}">
        <span>${escapeHTML(label)}</span><span class="count">${count}</span>
      </div>`;
    }
  }

  function setCategory(c){
    State.filter.category = c;
    renderList();
    renderCategories();
    // After picking a category, scroll list back to top
    const list = $('entry-list');
    if (list) list.scrollTop = 0;
  }

  function filteredEntries(){
    const q = State.filter.query.trim().toLowerCase();
    const c = State.filter.category;
    return State.vault.entries
      .filter(e => {
        if (c === '__fav__' && !e.favorite) return false;
        if (c !== 'all' && c !== '__fav__' && (e.category || 'Login') !== c) return false;
        if (!q) return true;
        return (e.title||'').toLowerCase().includes(q)
          || (e.username||'').toLowerCase().includes(q)
          || (e.email||'').toLowerCase().includes(q)
          || (e.url||'').toLowerCase().includes(q)
          || (e.notes||'').toLowerCase().includes(q);
      })
      .sort((a,b) => (a.title||'').localeCompare(b.title||''));
  }

  function renderList(){
    const list = filteredEntries();
    const html = list.map(e => `
      <li class="entry${e.id === State.selectedId ? ' active' : ''}" data-id="${e.id}">
        ${avatarHTML(e)}
        <div class="meta">
          <div class="t">${escapeHTML(e.title || 'Untitled')} ${e.favorite ? '<span class="star">★</span>' : ''}</div>
          <div class="u">${escapeHTML(e.username || e.email || e.url || '—')}</div>
        </div>
      </li>
    `).join('');
    $('entry-list').innerHTML = html || `<li class="entry" style="cursor:default;color:var(--text-dim)"><div class="meta"><div class="t">No entries</div><div class="u">Tap + to add one</div></div></li>`;
    wireFaviconFallback($('entry-list'));
    // Stagger each entry's fade-in for a smooth list reveal
    $$('.entry[data-id]', $('entry-list')).forEach((el, i) => {
      el.style.animationDelay = Math.min(i, 12) * 28 + 'ms';
    });
    $$('.entry[data-id]', $('entry-list')).forEach(el => el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (window.innerWidth <= 820){
        openDetailModal(id);
      } else {
        State.selectedId = id;
        renderList();
        renderDetail();
        document.querySelector('.content').classList.add('show-detail');
      }
    }));
  }

  function renderDetail(){
    const el = $('detail');
    const e = State.vault.entries.find(x => x.id === State.selectedId);
    if (!e){
      el.innerHTML = `<div class="empty">
        <svg viewBox="0 0 24 24" width="60" height="60" opacity=".2"><path fill="currentColor" d="M12 1a6 6 0 0 0-6 6v3H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V7a6 6 0 0 0-6-6Zm-4 9V7a4 4 0 1 1 8 0v3H8Z"/></svg>
        <p>Select an entry, or add a new one.</p></div>`;
      return;
    }
    const url = e.url || '';
    const urlPretty = url.replace(/^https?:\/\//,'').replace(/\/$/,'');
    const updated = e.updatedAt ? new Date(e.updatedAt).toLocaleString() : '';
    el.innerHTML = `
      <button class="btn ghost only-mobile" id="back-to-list" style="align-self:flex-start">← Back</button>
      <div class="detail-head">
        ${avatarHTML(e)}
        <div>
          <h2>${escapeHTML(e.title || 'Untitled')} ${e.favorite ? '<span class="star">★</span>' : ''}</h2>
          <div class="sub">${escapeHTML(e.category || 'Login')} · updated ${escapeHTML(updated)}</div>
          <div class="actions">
            <button class="btn primary" id="d-edit">Edit</button>
            <button class="btn ghost" id="d-fav">${e.favorite ? 'Unfavorite' : 'Favorite'}</button>
            <button class="btn danger ghost" id="d-del">Delete</button>
          </div>
        </div>
      </div>

      ${row('Username', escapeHTML(e.username || ''), e.username ? `<button class="icon-btn" data-copy-user title="Copy">${iconCopy()}</button>` : '')}

      ${row('Email', escapeHTML(e.email || ''), e.email ? `<button class="icon-btn" data-copy-email title="Copy">${iconCopy()}</button>` : '')}

      <div class="row">
        <div class="lbl">Password</div>
        <div class="val">
          <span class="v" id="pw-view">••••••••••••</span>
          <div class="controls">
            <button class="icon-btn" id="pw-toggle" title="Show / hide">${iconEye()}</button>
            <button class="icon-btn" id="pw-copy" title="Copy">${iconCopy()}</button>
          </div>
        </div>
      </div>

      ${url ? `<div class="row">
        <div class="lbl">Website</div>
        <div class="val"><a href="${escapeHTML(normalizeURL(url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(urlPretty)}</a>
          <div class="controls"><button class="icon-btn" id="url-copy" title="Copy">${iconCopy()}</button></div>
        </div>
      </div>` : ''}

      ${e.notes ? `<div class="row"><div class="lbl">Notes</div><div class="notes">${escapeHTML(e.notes)}</div></div>` : ''}
    `;

    // Wire up
    $('d-edit').onclick = () => openEdit(e.id);
    $('d-del').onclick = () => deleteEntry(e.id);
    $('d-fav').onclick = async () => {
      e.favorite = !e.favorite; e.updatedAt = new Date().toISOString();
      await saveVault(); renderList(); renderDetail(); renderCategories();
      requestAnimationFrame(() => {
        const star = document.querySelector('.detail .star');
        if (star){ star.classList.remove('pop'); void star.offsetWidth; star.classList.add('pop'); }
      });
    };
    if ($('back-to-list')) $('back-to-list').onclick = () => document.querySelector('.content').classList.remove('show-detail');

    let pwShown = false;
    $('pw-toggle').onclick = () => {
      pwShown = !pwShown;
      $('pw-view').textContent = pwShown ? (e.password || '') : '••••••••••••';
    };
    $('pw-copy').onclick = () => copyAndClear(e.password || '', 'Password copied');
    if ($('url-copy')) $('url-copy').onclick = () => copyAndClear(url, 'URL copied');
    const cu = el.querySelector('[data-copy-user]');
    if (cu) cu.onclick = () => copyAndClear(e.username || '', 'Username copied');
    const ce = el.querySelector('[data-copy-email]');
    if (ce) ce.onclick = () => copyAndClear(e.email || '', 'Email copied');
    wireFaviconFallback(el);

    function row(lbl, valHTML, controls){
      return `<div class="row"><div class="lbl">${lbl}</div>
        <div class="val"><span class="v">${valHTML || '<span style="color:var(--text-dim)">—</span>'}</span>
          <div class="controls">${controls || ''}</div></div></div>`;
    }
    function iconCopy(){ return `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>`; }
    function iconEye(){ return `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></svg>`; }
  }

  // ---------- Category picker ----------
  const DEFAULT_CATS = ['Login','Banking','Email','Social','Work','Shopping'];
  function allCategories(){
    const set = new Set(DEFAULT_CATS);
    // Categories already in use on entries
    State.vault.entries.forEach(e => {
      const c = (e.category || 'Login').trim();
      if (c) set.add(c);
    });
    // User-created categories saved in prefs (persist even if no entry uses them yet)
    (State.prefs.userCats || []).forEach(c => { if (c && c.trim()) set.add(c.trim()); });
    return [...set].sort((a,b) => a.localeCompare(b));
  }

  async function registerUserCategory(name){
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    // Skip if it duplicates an existing one (case-insensitive)
    const existing = allCategories().find(c => c.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    if (!Array.isArray(State.prefs.userCats)) State.prefs.userCats = [];
    if (!State.prefs.userCats.some(c => c.toLowerCase() === trimmed.toLowerCase())){
      State.prefs.userCats.push(trimmed);
      try { await persistPrefs(); } catch {}
    }
    return trimmed;
  }

  function openCategoryPicker(current, onPick){
    const cats = allCategories();
    const listHTML = cats.map(c => `
      <button type="button" class="cat-item${c === current ? ' active' : ''}" data-cat="${escapeHTML(c)}">
        <span>${escapeHTML(c)}</span>
        ${c === current ? '<span class="check">✓</span>' : ''}
      </button>`).join('') +
      `<button type="button" class="cat-item cat-new" data-cat="__new__">
        <span>+ New category…</span>
      </button>`;

    $('cats-list').innerHTML = listHTML;
    $('cats-new-row').hidden = true;
    $('cats-new-input').value = '';
    $('cats-confirm').hidden = true;

    $('cats-list').onclick = (e) => {
      const btn = e.target.closest('.cat-item');
      if (!btn) return;
      if (btn.dataset.cat === '__new__'){
        $('cats-new-row').hidden = false;
        $('cats-confirm').hidden = false;
        setTimeout(() => $('cats-new-input').focus(), 60);
      } else {
        onPick(btn.dataset.cat);
        closeModal('modal-cats');
      }
    };

    $('cats-confirm').onclick = async () => {
      const raw = $('cats-new-input').value.trim();
      if (!raw) { $('cats-new-input').focus(); return; }
      // Persist into State.prefs.userCats so it's available for ALL future entries
      const name = await registerUserCategory(raw) || raw;
      onPick(name);
      closeModal('modal-cats');
    };

    $('cats-new-input').onkeydown = (e) => {
      if (e.key === 'Enter'){ e.preventDefault(); $('cats-confirm').click(); }
    };

    openModal('modal-cats');
  }

  // ---------- Detail modal (mobile entry popup) ----------
  function openDetailModal(id){
    const e = State.vault.entries.find(x => x.id === id);
    if (!e) return;
    const url = e.url || '';
    const urlPretty = url.replace(/^https?:\/\//,'').replace(/\/$/,'');
    const updated = e.updatedAt ? new Date(e.updatedAt).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }) : '';
    const ico = (path) => `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="${path}"/></svg>`;
    const copyIco = 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z';
    const eyeIco = 'M12 5c-7 0-11 7-11 7s4 7 11 7 11-7 11-7-4-7-11-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z';

    $('md-head').innerHTML = `
      ${avatarHTML(e)}
      <div class="tt">
        <h3>${escapeHTML(e.title || 'Untitled')} ${e.favorite ? '<span class="star">★</span>' : ''}</h3>
        <div class="sub">${escapeHTML(e.category || 'Login')} · updated ${escapeHTML(updated)}</div>
      </div>`;

    const rows = [];
    rows.push(row('Username', e.username, e.username ? [{ act:'copy-user', icon:copyIco, label:'Copy' }] : []));
    rows.push(row('Email', e.email, e.email ? [{ act:'copy-email', icon:copyIco, label:'Copy' }] : []));
    rows.push(`<div class="detail-row">
      <div class="lbl">Password</div>
      <div class="v-wrap">
        <span class="v" id="md-pw" data-pw-shown="0">${e.password ? '••••••••••••' : '<span class="v muted">(empty)</span>'}</span>
        <div class="ctrls">
          ${e.password ? `<button class="icon-btn" data-act="pw-toggle" aria-label="Show">${ico(eyeIco)}</button>
          <button class="icon-btn" data-act="copy-pw" aria-label="Copy">${ico(copyIco)}</button>` : ''}
        </div>
      </div></div>`);
    if (url) rows.push(`<div class="detail-row">
      <div class="lbl">Website</div>
      <div class="v-wrap">
        <a href="${escapeHTML(normalizeURL(url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(urlPretty)}</a>
        <div class="ctrls"><button class="icon-btn" data-act="copy-url" aria-label="Copy">${ico(copyIco)}</button></div>
      </div></div>`);
    if (e.notes) rows.push(`<div class="detail-row">
      <div class="lbl">Notes</div>
      <div class="notes">${escapeHTML(e.notes)}</div></div>`);

    $('md-rows').innerHTML = rows.join('');

    // Favorite button label
    $('md-fav').textContent = e.favorite ? '★ Unfavorite' : '☆ Favorite';

    // Wire actions
    $('md-rows').onclick = (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'copy-user') copyAndClear(e.username || '', 'Username copied');
      else if (a === 'copy-email') copyAndClear(e.email || '', 'Email copied');
      else if (a === 'copy-pw') copyAndClear(e.password || '', 'Password copied');
      else if (a === 'copy-url') copyAndClear(normalizeURL(url), 'URL copied');
      else if (a === 'pw-toggle'){
        const pwEl = $('md-pw');
        const shown = pwEl.dataset.pwShown === '1';
        pwEl.textContent = shown ? '••••••••••••' : (e.password || '');
        pwEl.dataset.pwShown = shown ? '0' : '1';
      }
    };

    $('md-edit').onclick = () => { closeModal('modal-detail'); openEdit(id); };
    $('md-delete').onclick = () => { closeModal('modal-detail'); deleteEntry(id); };
    $('md-fav').onclick = async () => {
      e.favorite = !e.favorite; e.updatedAt = new Date().toISOString();
      await saveVault();
      renderList(); renderCategories();
      openDetailModal(id); // re-render with updated state
      // Pop the star in the just-rerendered modal
      requestAnimationFrame(() => {
        const star = document.querySelector('#md-head .star');
        if (star){ star.classList.remove('pop'); void star.offsetWidth; star.classList.add('pop'); }
      });
    };

    wireFaviconFallback($('md-head'));
    openModal('modal-detail');

    function row(lbl, value, ctrls){
      const isEmpty = !value;
      const valHTML = isEmpty
        ? `<span class="v muted plain">(empty)</span>`
        : `<span class="v plain">${escapeHTML(value)}</span>`;
      const ctrlsHTML = (ctrls || []).map(c => `<button class="icon-btn" data-act="${c.act}" aria-label="${c.label}">${ico(c.icon)}</button>`).join('');
      return `<div class="detail-row">
        <div class="lbl">${lbl}</div>
        <div class="v-wrap">${valHTML}<div class="ctrls">${ctrlsHTML}</div></div>
      </div>`;
    }
  }

  // ---------- CRUD ----------
  function openEdit(id){
    const e = id ? State.vault.entries.find(x => x.id === id) : null;
    $('edit-title').textContent = e ? 'Edit entry' : 'New entry';
    $('edit-id').value = e?.id || '';
    $('edit-title-input').value = e?.title || '';
    $('edit-username').value = e?.username || '';
    $('edit-email').value = e?.email || '';
    $('edit-password').value = e?.password || '';
    $('edit-url').value = e?.url || '';
    const cat = e?.category || 'Login';
    $('edit-category').value = cat;
    $('edit-category-display').textContent = cat;
    $('edit-notes').value = e?.notes || '';
    $('edit-favorite').checked = !!e?.favorite;
    $('edit-delete').hidden = !e;
    setStrengthMeter($('edit-strength'), Crypto.strengthScore($('edit-password').value));
    openModal('modal-edit');
    setTimeout(() => $('edit-title-input').focus(), 50);
  }

  async function deleteEntry(id){
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    State.vault.entries = State.vault.entries.filter(e => e.id !== id);
    if (State.selectedId === id) State.selectedId = null;
    await saveVault();
    renderList(); renderDetail(); renderCategories();
    toast('Deleted');
  }

  // ---------- Bootstrap ----------
  async function init(){
    const meta = await loadMeta();
    if (!meta || !meta.hasVault){
      mountSetup();
      showScreen('screen-setup');
    } else {
      State.salt = meta.salt;
      State.iterations = meta.iterations || Crypto.KDF_ITERATIONS;
      State.prefs = Object.assign(State.prefs, meta.prefs || {});
      mountUnlock();
      showScreen('screen-lock');
    }
    // Apply the theme we know about (localStorage already applied pre-paint, this re-syncs)
    applyTheme(State.prefs.theme || 'auto');
    wireUI();
    maybeShowIOSHint();
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
  }

  function maybeShowIOSHint(){
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const dismissed = localStorage.getItem('ios-hint-dismissed') === '1';
    if (isIOS && !standalone && !dismissed){
      $('ios-hint').hidden = false;
    }
    const closeBtn = $('ios-hint-close');
    if (closeBtn) closeBtn.onclick = () => {
      $('ios-hint').hidden = true;
      try { localStorage.setItem('ios-hint-dismissed', '1'); } catch {}
    };
  }

  async function wipeEverything(){
    if (!confirm('This permanently deletes the entire vault on this device. Continue?')) return;
    if (!confirm('Last chance — all saved entries will be lost. Continue?')) return;
    try { await DB.clearAll(); } catch {}
    try { localStorage.clear(); } catch {}
    location.reload();
  }

  // ---------- PIN flows ----------
  let setupPin = null, unlockPin = null, cpwPin = null, impPin = null;

  function mountSetup(){
    let stage = 'create';   // create -> confirm
    let firstPin = '';
    const sub = $('setup-sub');
    const err = $('setup-error');
    sub.textContent = `Choose a ${PIN_LENGTH}-digit PIN`;
    err.hidden = true;
    setupPin = createPinEntry($('setup-pin'), async (pin) => {
      err.hidden = true;
      if (stage === 'create'){
        firstPin = pin;
        stage = 'confirm';
        sub.textContent = 'Re-enter to confirm';
        setupPin.clear();
        return;
      }
      // confirm
      if (pin !== firstPin){
        err.textContent = 'PINs did not match. Try again.';
        err.hidden = false;
        setupPin.shake();
        stage = 'create';
        firstPin = '';
        sub.textContent = `Choose a ${PIN_LENGTH}-digit PIN`;
        setTimeout(() => setupPin.clear(), 350);
        return;
      }
      sub.textContent = 'Creating vault…';
      try {
        State.salt = Crypto.randomBytes(Crypto.SALT_BYTES);
        State.iterations = Crypto.KDF_ITERATIONS;
        State.key = await Crypto.deriveKey(pin, State.salt, State.iterations);
        State.vault = { version: 1, entries: [] };
        await saveVault();
        await sleep(180);
        await enterAppAnimated();
      } catch (e) {
        err.textContent = 'Could not create vault: ' + (e.message || e);
        err.hidden = false;
        sub.textContent = `Choose a ${PIN_LENGTH}-digit PIN`;
        stage = 'create'; firstPin = '';
        setupPin.clear();
      }
    });
  }

  function mountUnlock(){
    const err = $('lock-error');
    err.hidden = true;
    unlockPin = createPinEntry($('lock-pin'), async (pin) => {
      err.hidden = true;
      try {
        const key = await Crypto.deriveKey(pin, State.salt, State.iterations);
        const enc = await loadEncryptedVault();
        if (!enc) throw new Error('Vault missing');
        const vault = await Crypto.decryptJSON(key, enc.iv, enc.ct);
        State.key = key;
        State.vault = vault;
        // brief hold so user sees all dots filled, then smoothly fade out lock screen
        await sleep(180);
        await enterAppAnimated();
      } catch (e) {
        err.textContent = 'Wrong PIN.';
        err.hidden = false;
        unlockPin.shake();
        setTimeout(() => unlockPin.clear(), 350);
      }
    });
  }

  function mountChangePin(){
    let stage = 'current';  // current -> new -> confirm
    let currentPin = '', newPin = '';
    const title = $('cpw-title');
    const sub = $('cpw-sub');
    const err = $('cpw-error');
    title.textContent = 'Change PIN';
    sub.textContent = 'Enter your current PIN';
    err.hidden = true;
    cpwPin = createPinEntry($('cpw-pin'), async (pin) => {
      err.hidden = true;
      if (stage === 'current'){
        try {
          const k = await Crypto.deriveKey(pin, State.salt, State.iterations);
          const enc = await loadEncryptedVault();
          await Crypto.decryptJSON(k, enc.iv, enc.ct);
          currentPin = pin; stage = 'new';
          sub.textContent = `Choose a new ${PIN_LENGTH}-digit PIN`;
          cpwPin.clear();
        } catch {
          err.textContent = 'Wrong PIN.'; err.hidden = false;
          cpwPin.shake();
          setTimeout(() => cpwPin.clear(), 350);
        }
        return;
      }
      if (stage === 'new'){
        if (pin === currentPin){
          err.textContent = 'New PIN must differ from the old one.'; err.hidden = false;
          cpwPin.shake();
          setTimeout(() => cpwPin.clear(), 350);
          return;
        }
        newPin = pin; stage = 'confirm';
        sub.textContent = 'Confirm new PIN';
        cpwPin.clear();
        return;
      }
      // confirm
      if (pin !== newPin){
        err.textContent = 'PINs did not match.'; err.hidden = false;
        cpwPin.shake();
        stage = 'new'; newPin = '';
        sub.textContent = `Choose a new ${PIN_LENGTH}-digit PIN`;
        setTimeout(() => cpwPin.clear(), 350);
        return;
      }
      try {
        State.salt = Crypto.randomBytes(Crypto.SALT_BYTES);
        State.iterations = Crypto.KDF_ITERATIONS;
        State.key = await Crypto.deriveKey(newPin, State.salt, State.iterations);
        await saveVault();
        closeModal('modal-changepw');
        toast('PIN changed');
      } catch (e) {
        err.textContent = 'Could not change PIN: ' + (e.message || e);
        err.hidden = false;
      }
    });
  }

  function mountImportPin(obj){
    const err = $('imp-error');
    err.hidden = true;
    impPin = createPinEntry($('imp-pin'), async (pin) => {
      err.hidden = true;
      try {
        const salt = Crypto.b64ToBytes(obj.kdf.salt);
        const iters = obj.kdf.iterations || Crypto.KDF_ITERATIONS;
        const key = await Crypto.deriveKey(pin, salt, iters);
        const iv = Crypto.b64ToBytes(obj.cipher.iv);
        const ct = Crypto.b64ToBytes(obj.cipher.ct);
        const importedVault = await Crypto.decryptJSON(key, iv, ct);
        const byId = new Map(State.vault.entries.map(e => [e.id, e]));
        let added = 0, updated = 0;
        for (const e of (importedVault.entries || [])){
          const existing = byId.get(e.id);
          if (!existing){ byId.set(e.id, e); added++; }
          else if ((e.updatedAt || '') > (existing.updatedAt || '')){ byId.set(e.id, e); updated++; }
        }
        State.vault.entries = [...byId.values()];
        await saveVault();
        renderCategories(); renderList(); renderDetail();
        closeModal('modal-import');
        toast(`Imported · +${added} new, ${updated} updated`);
      } catch (e) {
        err.textContent = 'Wrong PIN, or backup is invalid.';
        err.hidden = false;
        impPin.shake();
        setTimeout(() => impPin.clear(), 350);
      }
    });
  }

  function wireUI(){
    // Eye toggles
    document.body.addEventListener('click', (e) => {
      const t = e.target.closest('[data-toggle]');
      if (!t) return;
      const inp = $(t.dataset.toggle);
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    document.body.addEventListener('click', (e) => {
      const t = e.target.closest('[data-close-modal]');
      if (t) closeModal(t.dataset.closeModal);
    });
    // Tap on modal backdrop closes the sheet (iOS-native feel, with animation)
    $$('.modal').forEach(m => m.addEventListener('click', (e) => {
      if (e.target === m) closeModal(m);
    }));

    const lockWipe = $('wipe-btn');
    if (lockWipe){ lockWipe.onclick = wipeEverything; }
    const setupWipe = $('setup-wipe-btn');
    if (setupWipe){ setupWipe.onclick = wipeEverything; }

    // Sidebar toggle (mobile)
    // Sidebar toggle (desktop only — kept for any layouts where it might surface)
    const tog = $('toggle-sidebar'); if (tog) tog.onclick = () => $('sidebar').classList.toggle('open');

    // Search
    $('search-input').addEventListener('input', (e) => {
      State.filter.query = e.target.value;
      renderList();
    });

    // Add / lock / settings — desktop and mobile variants
    $('add-btn').onclick = () => openEdit(null);
    const fab = $('fab-add'); if (fab) fab.onclick = () => openEdit(null);
    $('lock-now').onclick = lock;
    const lockM = $('lock-now-mobile'); if (lockM) lockM.onclick = lock;
    $('open-settings').onclick = openSettings;
    const setM = $('open-settings-mobile'); if (setM) setM.onclick = openSettings;

    // Edit form
    bindStrength('edit-password', 'edit-strength', null);
    $('open-gen').onclick = () => openGenerator((pw) => {
      $('edit-password').value = pw;
      $('edit-password').dispatchEvent(new Event('input'));
    });
    $('edit-category-btn').onclick = () => {
      openCategoryPicker($('edit-category').value || 'Login', (chosen) => {
        $('edit-category').value = chosen;
        $('edit-category-display').textContent = chosen;
      });
    };
    $('form-edit').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = $('edit-id').value || Crypto.uuid();
      const existing = State.vault.entries.find(x => x.id === id);
      const now = new Date().toISOString();
      const data = {
        id,
        title: $('edit-title-input').value.trim(),
        username: $('edit-username').value,
        email: $('edit-email').value.trim(),
        password: $('edit-password').value,
        url: $('edit-url').value.trim(),
        category: ($('edit-category').value || 'Login').trim(),
        notes: $('edit-notes').value,
        favorite: $('edit-favorite').checked,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      if (existing) Object.assign(existing, data);
      else State.vault.entries.push(data);
      State.selectedId = data.id;
      await saveVault();
      closeModal('modal-edit');
      renderCategories(); renderList(); renderDetail();
      toast('Saved');
    });
    $('edit-delete').addEventListener('click', () => {
      const id = $('edit-id').value;
      if (!id) return;
      closeModal('modal-edit');
      deleteEntry(id);
    });

    // Generator
    const genState = { length: 20 };
    const refreshGen = () => {
      const opts = {
        length: parseInt($('gen-len').value, 10),
        upper: $('gen-upper').checked, lower: $('gen-lower').checked,
        digit: $('gen-digit').checked, sym: $('gen-sym').checked,
        avoidAmbiguous: $('gen-amb').checked,
      };
      $('gen-len-val').value = opts.length;
      const pw = Crypto.generatePassword(opts);
      $('gen-result').textContent = pw;
      setStrengthMeter($('gen-strength'), Crypto.strengthScore(pw));
      genState.current = pw;
    };
    ['gen-len','gen-upper','gen-lower','gen-digit','gen-sym','gen-amb'].forEach(id => $(id).addEventListener('input', refreshGen));
    $('gen-refresh').onclick = refreshGen;
    $('gen-copy').onclick = () => copyAndClear(genState.current || '', 'Generated password copied');
    $('gen-use').onclick = () => {
      if (genState._cb){ genState._cb(genState.current); genState._cb = null; }
      closeModal('modal-gen');
    };
    function openGenerator(cb){
      genState._cb = cb || null;
      refreshGen();
      openModal('modal-gen');
    }
    window._openGenerator = openGenerator;

    // Settings
    // Theme picker
    document.querySelectorAll('[data-theme-pick]').forEach(b => {
      b.addEventListener('click', async () => {
        applyTheme(b.dataset.themePick);
        try { await persistPrefs(); } catch {}
      });
    });

    $('set-autolock').addEventListener('change', async () => {
      const v = Math.max(1, Math.min(120, parseInt($('set-autolock').value, 10) || 5));
      State.prefs.autoLockMin = v; $('set-autolock').value = v;
      await persistPrefs(); resetIdle();
    });
    $('set-clipclear').addEventListener('change', async () => {
      const v = Math.max(5, Math.min(300, parseInt($('set-clipclear').value, 10) || 20));
      State.prefs.clipClearSec = v; $('set-clipclear').value = v;
      await persistPrefs();
    });
    $('open-change-pw').onclick = () => {
      closeModal('modal-settings');
      mountChangePin();
      openModal('modal-changepw');
    };
    $('wipe-vault').onclick = async () => {
      if (!confirm('Permanently wipe the entire vault on this device?')) return;
      if (!confirm('Last chance. Continue?')) return;
      await DB.clearAll(); location.reload();
    };
    $('export-btn').onclick = exportBackup;
    $('import-btn').onclick = () => $('import-file').click();
    $('import-file').addEventListener('change', importBackup);

  }

  function openSettings(){
    $('set-autolock').value = State.prefs.autoLockMin;
    $('set-clipclear').value = State.prefs.clipClearSec;
    document.querySelectorAll('[data-theme-pick]').forEach(b => {
      b.classList.toggle('active', b.dataset.themePick === (State.prefs.theme || 'auto'));
    });
    openModal('modal-settings');
  }

  function enterApp(){
    showScreen('screen-app');
    renderCategories();
    renderList();
    renderDetail();
    resetIdle();
    $('search-input').value = '';
  }

  async function enterAppAnimated(){
    await transitionToScreen('screen-app');
    renderCategories();
    renderList();
    renderDetail();
    resetIdle();
    $('search-input').value = '';
  }

  // ---------- Backup ----------
  async function exportBackup(){
    // Export the EXISTING ciphertext + salt — already encrypted with the master password.
    const enc = await loadEncryptedVault();
    const payload = {
      app: 'Credentials',
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: State.iterations,
             salt: Crypto.bytesToB64(State.salt) },
      cipher: { name: 'AES-GCM',
                iv: Crypto.bytesToB64(enc.iv),
                ct: Crypto.bytesToB64(enc.ct) },
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    a.href = URL.createObjectURL(blob);
    a.download = `credentials-backup-${ts}.creds`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Backup downloaded');
  }

  async function importBackup(ev){
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const obj = JSON.parse(text);
      if (obj.app !== 'Credentials' || !obj.kdf || !obj.cipher) throw new Error('Not a Credentials backup');
      mountImportPin(obj);
      openModal('modal-import');
    } catch (e) {
      toast('Invalid backup file');
    }
  }

  // Boot
  init().catch(err => {
    console.error(err);
    alert('Failed to start: ' + (err.message || err));
  });
})();
