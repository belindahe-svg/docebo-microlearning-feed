// aTalent micro-learning feed: browser side.
// 1. Hands the Docebo iFrame widget parameters to /api/session, then strips them from the URL.
// 2. Loads the feed, plays videos as they come into view, and syncs likes, saves and comments.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const feedEl = $('feed');
  const statusEl = $('status');
  const toastEl = $('toast');
  const sheet = $('sheet');
  const clist = $('clist');

  let token = null;
  let me = null;
  let all = [];          // every card the learner can see
  let items = [];        // the current filtered view (cards are rendered from this)
  let channelNames = [];
  const filter = { type: 'all', channel: '', q: '' };
  let cards = [];
  let io = null;
  let cur = -1;
  let muted = true;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PROGRESS_STEPS = [25, 50, 75, 90, 100];
  const PALETTE = [
    ['#4a2a85', '#1f6f8b'], ['#7a3b15', '#c06a2b'], ['#23445f', '#3f8f8a'], ['#3a2255', '#8a4a7a'],
    ['#1e4d3a', '#4f8a4a'], ['#2a2f6b', '#5a4ab0'], ['#5b3a1a', '#a8772e'], ['#5a1e3c', '#b0485a'],
  ];

  const ICON = {
    heart: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.5 2.9 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3 1.7-1.9 3.2-3 5.3-3 3.8 0 5.8 4 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="30" height="30" fill="#fff" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { toastEl.hidden = true; }, 4000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  // ---------- session ----------
  async function startSession() {
    const params = Object.fromEntries(new URLSearchParams(location.search));
    const s = await api('/api/session', { method: 'POST', body: JSON.stringify(params) });
    token = s.token;
    me = s.user;
    startSession.discovery = !!s.discovery;
    startSession.receivedParams = s.receivedParams || [];
    // The auth code is single-use; remove it from the address so it is never reused or logged.
    if (location.search) history.replaceState(null, '', location.pathname);
  }

  // ---------- rendering ----------
  function statusChip(status) {
    if (!status) return '';
    const cls = /progress/i.test(status) ? 'prog' : /complet/i.test(status) ? 'done' : '';
    return `<span class="chip ${cls}">${esc(status)}</span>`;
  }

  function kindLabel(it) {
    if (it.kind === 'course') return it.subtype ? `${it.subtype} course` : 'Course';
    if (it.kind === 'learning_plan') return 'Learning plan';
    return it.subtype ? `${it.subtype} asset` : 'Asset';
  }

  function ctaLabel(it) {
    if (it.kind === 'asset') return 'Open in Docebo';
    if (/progress/i.test(it.status || '')) return 'Resume in Docebo';
    if (/complet/i.test(it.status || '')) return 'Review in Docebo';
    return 'Start in Docebo';
  }

  function cardHtml(it, i) {
    const [c1, c2] = PALETTE[i % PALETTE.length];
    const e = it.engagement;
    const visual = it.videoUrl
      ? `<video preload="metadata" playsinline muted ${it.thumbnailUrl ? `poster="${esc(it.thumbnailUrl)}"` : ''} src="${esc(it.videoUrl)}"></video>
         <div class="playstate">${ICON.play}</div>
         <button type="button" class="mute" aria-label="Unmute">Sound off</button>`
      : `<div class="art" style="background:linear-gradient(160deg,${c1},${c2})">${it.thumbnailUrl ? `<img alt="" src="${esc(it.thumbnailUrl)}">` : ''}</div>
         <div class="big">${esc(it.title)}</div>`;
    const yt = it.youtubeId && !it.videoUrl;
    return `<article class="card${yt ? ' yt paused' : ''}" data-i="${i}" data-key="${esc(it.key)}" aria-label="${esc(it.title)}">
      ${visual}
      ${yt ? `<div class="playstate">${ICON.play}</div>` : ''}
      <div class="shade"></div>
      <div class="meta">
        <div class="chips"><span class="chip">${esc(kindLabel(it))}</span>${statusChip(it.status)}${it.rating ? `<span class="chip">★ ${esc(it.rating)}</span>` : ''}</div>
        <p class="ttl">${esc(it.title)}</p>
        ${it.description ? `<p class="desc">${esc(it.description)}</p>` : ''}
        <a class="cta" href="${esc(it.doceboUrl)}" target="_top">${ctaLabel(it)}</a>
      </div>
      <div class="rail">
        <button type="button" class="rbtn like" aria-pressed="${e.liked}" aria-label="Like">${ICON.heart}<span>${e.likes}</span></button>
        <button type="button" class="rbtn com" aria-label="Comments">${ICON.chat}<span>${e.comments}</span></button>
        <button type="button" class="rbtn save" aria-pressed="${e.saved}" aria-label="Save">${ICON.save}<span>${e.saved ? 'Saved' : 'Save'}</span></button>
      </div>
      ${it.videoUrl ? '<div class="bar"><i></i></div>' : ''}
    </article>`;
  }

  function render() {
    feedEl.innerHTML = items.map(cardHtml).join('');
    cards = [...feedEl.querySelectorAll('.card')];
    cards.forEach((card, i) => {
      const v = card.querySelector('video');
      if (v) wireVideo(v, card, items[i]);
    });
    if (io) io.disconnect();
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) activate(Number(e.target.dataset.i));
    }, { root: feedEl, threshold: [0.6] });
    cards.forEach((c) => io.observe(c));
    for (let k = 0; k < 4; k++) enrich(k);
  }

  // ---------- video ----------
  // HLS (.m3u8) plays natively in Safari; elsewhere load hls.js on first use.
  let hlsLib = null;
  function loadHls() {
    hlsLib ??= new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js';
      sc.onload = () => res(window.Hls);
      sc.onerror = rej;
      document.head.appendChild(sc);
    });
    return hlsLib;
  }

  function wireVideo(v, card, it) {
    if (/\.m3u8(\?|$)/i.test(it.videoUrl) && !v.canPlayType('application/vnd.apple.mpegurl')) {
      v.removeAttribute('src');
      loadHls().then((Hls) => {
        if (!Hls?.isSupported()) throw new Error('no hls');
        const h = new Hls();
        h.loadSource(it.videoUrl);
        h.attachMedia(v);
      }).catch(() => toast(`This video can't play here. Use "Open in Docebo" instead.`));
    }
    const bar = card.querySelector('.bar i');
    const sent = new Set();
    v.addEventListener('timeupdate', () => {
      if (!v.duration) return;
      const pct = Math.floor((v.currentTime / v.duration) * 100);
      bar.style.width = `${pct}%`;
      for (const step of PROGRESS_STEPS) {
        if (pct >= step && !sent.has(step)) {
          sent.add(step);
          api(`/api/items/${encodeURIComponent(it.key)}/progress`, { method: 'POST', body: JSON.stringify({ percent: step }) })
            .catch(() => {});
        }
      }
    });
    v.addEventListener('ended', () => {
      if (!sent.has(100)) {
        sent.add(100);
        api(`/api/items/${encodeURIComponent(it.key)}/progress`, { method: 'POST', body: JSON.stringify({ percent: 100 }) }).catch(() => {});
      }
      card.classList.add('paused');
    });
    v.addEventListener('error', () => toast(`This video can't play here. Use "Open in Docebo" instead.`));
  }

  // ---------- asset media (lazy) ----------
  // Asset cards arrive without thumbnails or video info; fetch them as cards come near the viewport.
  const mediaReq = new Map(); // item key -> promise
  function enrichItem(it) {
    if (!it || it.kind !== 'asset') return Promise.resolve();
    if (!mediaReq.has(it.key)) {
      mediaReq.set(it.key, api(`/api/assets/${encodeURIComponent(it.id)}/media`)
        .then((m) => applyMedia(it, m))
        .catch(() => {}));
    }
    return mediaReq.get(it.key);
  }
  function enrich(i) { enrichItem(items[i]); }

  // Swap a rendered card for a fresh one (e.g. once we learn it is a playable video).
  function replaceCard(i) {
    const old = cards[i];
    const tmp = document.createElement('div');
    tmp.innerHTML = cardHtml(items[i], i);
    const card = tmp.firstElementChild;
    old.replaceWith(card);
    cards[i] = card;
    const v = card.querySelector('video');
    if (v) wireVideo(v, card, items[i]);
    if (io) { io.unobserve?.(old); io.observe(card); }
    if (i === cur && v) { v.muted = muted; v.play().then(() => card.classList.remove('paused')).catch(() => card.classList.add('paused')); }
  }

  // The Videos filter needs every asset's type, so look them all up (a few at a time).
  async function enrichAllAssets() {
    const todo = all.filter((it) => it.kind === 'asset' && !mediaReq.has(it.key));
    for (let k = 0; k < todo.length; k += 6) await Promise.all(todo.slice(k, k + 6).map(enrichItem));
    await Promise.all(all.filter((it) => it.kind === 'asset').map((it) => mediaReq.get(it.key)));
  }

  function applyMedia(it, m) {
    if (m.subtype) it.subtype = m.subtype;
    if (m.thumbnailUrl && !it.thumbnailUrl) it.thumbnailUrl = m.thumbnailUrl;
    if (m.youtubeId && !it.videoUrl) it.youtubeId = m.youtubeId;
    const idx = items.indexOf(it);
    if (m.videoUrl && !it.videoUrl) {
      it.videoUrl = m.videoUrl;
      if (idx >= 0 && cards[idx]) replaceCard(idx);
      return;
    }
    const card = cards[idx];
    if (!card) return;
    const chip = card.querySelector('.chips .chip');
    if (chip) chip.textContent = kindLabel(it);
    const art = card.querySelector('.art');
    if (art && it.thumbnailUrl && !art.querySelector('img')) {
      art.insertAdjacentHTML('afterbegin', `<img alt="" src="${esc(it.thumbnailUrl)}">`);
    }
    if (it.youtubeId && !it.videoUrl && !card.classList.contains('yt')) {
      card.classList.add('yt', 'paused');
      if (!card.querySelector('.playstate')) card.insertAdjacentHTML('beforeend', `<div class="playstate">${ICON.play}</div>`);
    }
  }

  // YouTube rejects embeds that send no Referer (error 153). The page keeps Referrer-Policy: no-referrer;
  // this frame alone sends the origin (no path or query), after the auth code has left the address bar.
  function startYouTube(card, it) {
    if (card.querySelector('iframe.ytframe')) return;
    // Standard youtube.com player (not nocookie): a signed-in YouTube session can then clear YouTube's bot check.
    const src = `https://www.youtube.com/embed/${encodeURIComponent(it.youtubeId)}?autoplay=1&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(location.origin)}`;
    card.insertAdjacentHTML('beforeend', `<iframe class="ytframe" src="${src}" title="${esc(it.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
      <a class="ytout" href="https://www.youtube.com/watch?v=${encodeURIComponent(it.youtubeId)}" target="_blank" rel="noopener">Not playing? Watch on YouTube</a>`);
    card.classList.remove('paused');
    card.classList.add('playing');
    // Feed analytics only: "started" in this app. Docebo's own view record needs "Open in Docebo".
    api(`/api/items/${encodeURIComponent(it.key)}/progress`, { method: 'POST', body: JSON.stringify({ percent: 1 }) }).catch(() => {});
  }

  function stopYouTube(card) {
    const f = card?.querySelector('iframe.ytframe');
    if (!f) return;
    f.remove();
    card.querySelector('.ytout')?.remove();
    card.classList.remove('playing');
    card.classList.add('paused');
  }

  function activate(i) {
    if (i === cur) return;
    if (cur >= 0) {
      const pv = cards[cur].querySelector('video');
      if (pv) pv.pause();
      stopYouTube(cards[cur]);
    }
    cur = i;
    for (let k = i; k <= i + 3; k++) enrich(k);
    const v = cards[i].querySelector('video');
    if (v) {
      v.muted = muted;
      v.play().then(() => cards[i].classList.remove('paused')).catch(() => cards[i].classList.add('paused'));
    }
  }

  function togglePlay(card) {
    const it = items[Number(card.dataset.i)];
    if (it?.youtubeId) {
      if (card.querySelector('iframe.ytframe')) stopYouTube(card);
      else startYouTube(card, it);
      return;
    }
    const v = card.querySelector('video');
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); card.classList.remove('paused'); }
    else { v.pause(); card.classList.add('paused'); }
  }

  function setMuted(m) {
    muted = m;
    for (const c of cards) {
      const v = c.querySelector('video');
      if (v) v.muted = m;
      const b = c.querySelector('.mute');
      if (b) { b.textContent = m ? 'Sound off' : 'Sound on'; b.setAttribute('aria-label', m ? 'Unmute' : 'Mute'); }
    }
  }

  function go(d) {
    const n = Math.max(0, Math.min(cards.length - 1, cur + d));
    cards[n]?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // ---------- engagement ----------
  async function toggleFlag(btn, it, kind) {
    const e = it.engagement;
    const on = kind === 'like' ? !e.liked : !e.saved;
    btn.disabled = true;
    try {
      const r = await api(`/api/items/${encodeURIComponent(it.key)}/${kind}`, { method: 'POST', body: JSON.stringify({ on }) });
      if (kind === 'like') { e.liked = r.liked; e.likes = r.likes; btn.querySelector('span').textContent = e.likes; }
      else { e.saved = r.saved; btn.querySelector('span').textContent = e.saved ? 'Saved' : 'Save'; }
      btn.setAttribute('aria-pressed', String(kind === 'like' ? e.liked : e.saved));
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  }

  function fmtWhen(sec) {
    const d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 60) return 'now';
    if (d < 3600) return `${Math.floor(d / 60)}m`;
    if (d < 86400) return `${Math.floor(d / 3600)}h`;
    return `${Math.floor(d / 86400)}d`;
  }

  let sheetItem = null;
  function renderComments(list) {
    clist.innerHTML = list.length
      ? list.map((c) => `<li data-id="${c.id}"><span class="who">${esc(c.username)}</span><span class="when">${fmtWhen(c.createdAt)}</span>${c.mine ? '<button type="button" class="del">Delete</button>' : ''}<div>${esc(c.body)}</div></li>`).join('')
      : '<li class="empty">No comments yet. Start the conversation.</li>';
    $('sheetTitle').textContent = `Comments (${list.length})`;
  }
  let sheetList = [];
  async function openSheet(i) {
    sheetItem = items[i];
    sheetList = [];
    renderComments(sheetList);
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    $('cinput').focus();
    try {
      sheetList = (await api(`/api/items/${encodeURIComponent(sheetItem.key)}/comments`)).comments;
      renderComments(sheetList);
    } catch (err) { toast(err.message); }
  }
  function closeSheet() {
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    feedEl.focus();
  }
  function updateCommentCount() {
    const i = items.indexOf(sheetItem);
    sheetItem.engagement.comments = sheetList.length;
    if (i >= 0) cards[i].querySelector('.com span').textContent = sheetList.length;
  }

  // ---------- events ----------
  feedEl.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const i = Number(card.dataset.i);
    const it = items[i];
    const like = e.target.closest('.like');
    const save = e.target.closest('.save');
    if (like) return void toggleFlag(like, it, 'like');
    if (save) return void toggleFlag(save, it, 'save');
    if (e.target.closest('.com')) return void openSheet(i);
    if (e.target.closest('.mute')) return void setMuted(!muted);
    if (e.target.closest('a')) return;
    togglePlay(card);
  });
  feedEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); go(-1); }
    if (e.key === ' ' && cards[cur]) { e.preventDefault(); togglePlay(cards[cur]); }
    if (e.key === '/' && !$('topbar').hidden) { e.preventDefault(); openSearch(); }
  });
  $('closeSheet').addEventListener('click', closeSheet);
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  clist.addEventListener('click', async (e) => {
    const del = e.target.closest('.del');
    if (!del) return;
    const id = Number(del.closest('li').dataset.id);
    try {
      await api(`/api/comments/${id}`, { method: 'DELETE' });
      sheetList = sheetList.filter((c) => c.id !== id);
      renderComments(sheetList);
      updateCommentCount();
    } catch (err) { toast(err.message); }
  });
  $('cform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('cinput');
    const text = input.value.trim();
    if (!text || !sheetItem) return;
    try {
      const r = await api(`/api/items/${encodeURIComponent(sheetItem.key)}/comments`, { method: 'POST', body: JSON.stringify({ body: text }) });
      input.value = '';
      sheetList.push(r.comment);
      renderComments(sheetList);
      clist.scrollTop = clist.scrollHeight;
      updateCommentCount();
    } catch (err) { toast(err.message); }
  });

  // ---------- discovery mode ----------
  async function showDiscovery() {
    statusEl.textContent = 'Checking Docebo endpoints';
    const d = await api('/api/discover');
    const lines = [
      `Docebo endpoint check for ${d.domain}`,
      `Channel ID: ${d.channelId ?? '(not set)'}`,
      `iFrame parameters received: ${startSession.receivedParams.join(', ')}`,
      '',
      ...d.results.map((r) => `${String(r.status).padEnd(4)} ${r.label}\n     ${r.path}${r.detail ? `\n     ${r.detail}` : ''}`),
    ];
    const text = lines.join('\n');
    statusEl.hidden = true;
    feedEl.innerHTML = `<section class="discover">
      <h1>Endpoint check</h1>
      <p>Read-only checks run with your own Docebo session. Copy the results and paste them to Claude.</p>
      <button type="button" id="copyDiscover">Copy results</button>
      <button type="button" id="showFeed">Show feed</button>
      <pre id="discoverText"></pre>
    </section>`;
    $('discoverText').textContent = text;
    $('showFeed').addEventListener('click', () => {
      statusEl.hidden = false;
      statusEl.textContent = 'Loading';
      feedEl.innerHTML = '';
      loadFeed().catch((err) => { statusEl.textContent = `${err.message}`; });
    });
    $('copyDiscover').addEventListener('click', async (e) => {
      try {
        await navigator.clipboard.writeText(text);
        e.target.textContent = 'Copied';
      } catch {
        const r = document.createRange();
        r.selectNodeContents($('discoverText'));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        e.target.textContent = 'Press Ctrl+C or Cmd+C to copy';
      }
    });
  }

  // ---------- filters and search ----------
  const filtersEl = $('filters');
  const TYPES = [['all', 'All'], ['videos', 'Videos'], ['courses', 'Courses'], ['saved', 'Saved']];

  function isVideo(it) { return !!(it.videoUrl || it.youtubeId || /video/i.test(it.subtype || '')); }

  function matches(it) {
    if (filter.type === 'videos' && !isVideo(it)) return false;
    if (filter.type === 'courses' && it.kind !== 'course' && it.kind !== 'learning_plan') return false;
    if (filter.type === 'saved' && !it.engagement?.saved) return false;
    if (filter.channel && !(it.channels || []).includes(filter.channel)) return false;
    if (filter.q) {
      const hay = `${it.title} ${it.description || ''} ${(it.channels || []).join(' ')} ${it.subtype || ''}`.toLowerCase();
      if (!filter.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    return true;
  }

  function renderChips() {
    const typeChips = TYPES.map(([k, label]) =>
      `<button type="button" class="fchip" data-type="${k}" aria-pressed="${filter.type === k && (k !== 'all' || !filter.channel)}">${label}</button>`);
    const chanChips = channelNames.map((c) =>
      `<button type="button" class="fchip chan" data-channel="${esc(c)}" aria-pressed="${filter.channel === c}">${esc(c)}</button>`);
    filtersEl.innerHTML = typeChips.join('') + (chanChips.length ? '<span class="fsep" aria-hidden="true"></span>' + chanChips.join('') : '');
  }

  function emptyMessage() {
    if (filter.q) return `Nothing matches "${filter.q}".`;
    if (filter.type === 'saved') return 'Nothing saved yet. Tap Save on any card to keep it here.';
    if (filter.type === 'videos') return 'No videos here yet.';
    return 'Nothing here yet.';
  }

  function applyFilter() {
    if (cur >= 0 && cards[cur]) {
      cards[cur].querySelector('video')?.pause();
      stopYouTube(cards[cur]);
    }
    cur = -1;
    items = all.filter(matches);
    renderChips();
    feedEl.scrollTop = 0;
    if (!items.length) {
      if (io) io.disconnect();
      feedEl.innerHTML = '';
      cards = [];
      statusEl.hidden = false;
      statusEl.textContent = emptyMessage();
      return;
    }
    statusEl.hidden = true;
    render();
  }

  filtersEl.addEventListener('click', async (e) => {
    const b = e.target.closest('.fchip');
    if (!b) return;
    if (b.dataset.channel !== undefined) {
      filter.channel = filter.channel === b.dataset.channel ? '' : b.dataset.channel;
    } else if (b.dataset.type === 'all') {
      filter.type = 'all';
      filter.channel = '';
    } else {
      filter.type = filter.type === b.dataset.type ? 'all' : b.dataset.type;
    }
    if (filter.type === 'videos' && all.some((it) => it.kind === 'asset' && !mediaReq.has(it.key))) {
      feedEl.innerHTML = '';
      statusEl.hidden = false;
      statusEl.textContent = 'Finding videos';
      await enrichAllAssets();
    }
    applyFilter();
    b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });

  const searchRow = $('searchRow');
  const qEl = $('q');
  function openSearch() {
    searchRow.hidden = false;
    $('searchBtn').setAttribute('aria-expanded', 'true');
    qEl.focus();
  }
  function closeSearch() {
    searchRow.hidden = true;
    $('searchBtn').setAttribute('aria-expanded', 'false');
    if (filter.q) { filter.q = ''; qEl.value = ''; applyFilter(); }
    feedEl.focus({ preventScroll: true });
  }
  $('searchBtn').addEventListener('click', () => (searchRow.hidden ? openSearch() : closeSearch()));
  $('searchClose').addEventListener('click', closeSearch);
  searchRow.addEventListener('submit', (e) => { e.preventDefault(); qEl.blur(); });
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });
  let qTimer;
  qEl.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { filter.q = qEl.value.trim(); applyFilter(); }, 150);
  });

  // ---------- boot ----------
  async function loadFeed() {
    const feed = await api('/api/feed');
    all = feed.items;
    channelNames = feed.channels || [];
    if (!all.length) { statusEl.textContent = 'No items in your channels yet.'; return; }
    $('topbar').hidden = false;
    applyFilter();
    feedEl.focus({ preventScroll: true });
  }

  (async () => {
    try {
      await startSession();
      if (startSession.discovery) return void (await showDiscovery());
      await loadFeed();
    } catch (err) {
      statusEl.textContent = `${err.message}`;
    }
  })();
})();
