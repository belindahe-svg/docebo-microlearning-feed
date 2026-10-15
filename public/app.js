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
  let items = [];
  let cards = [];
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
    return `<article class="card" data-i="${i}" aria-label="${esc(it.title)}">
      ${visual}
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
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) activate(Number(e.target.dataset.i));
    }, { root: feedEl, threshold: [0.6] });
    cards.forEach((c) => io.observe(c));
  }

  // ---------- video ----------
  function wireVideo(v, card, it) {
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

  function activate(i) {
    if (i === cur) return;
    if (cur >= 0) {
      const pv = cards[cur].querySelector('video');
      if (pv) pv.pause();
    }
    cur = i;
    const v = cards[i].querySelector('video');
    if (v) {
      v.muted = muted;
      v.play().then(() => cards[i].classList.remove('paused')).catch(() => cards[i].classList.add('paused'));
    }
  }

  function togglePlay(card) {
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

  // ---------- boot ----------
  (async () => {
    try {
      await startSession();
      const feed = await api('/api/feed');
      items = feed.items;
      if (!items.length) { statusEl.textContent = 'This channel has no items yet.'; return; }
      statusEl.hidden = true;
      render();
      feedEl.focus({ preventScroll: true });
    } catch (err) {
      statusEl.textContent = `${err.message}`;
    }
  })();
})();
