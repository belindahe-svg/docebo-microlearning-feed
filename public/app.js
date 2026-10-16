// aTalent micro-learning feed: browser side.
// 1. Hands the Docebo iFrame widget parameters to /api/session, then strips them from the URL.
// 2. Loads the feed, plays videos as they come into view, and syncs likes, saves and comments.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const feedEl = $('feed');
  // Focusing a field inside a sliding panel makes the browser scroll the (clipped) stage to reveal
  // it, which left the layout shifted and stuck. The stage itself must never scroll.
  const stageEl = document.querySelector('.stage');
  stageEl.addEventListener('scroll', () => { if (stageEl.scrollTop || stageEl.scrollLeft) { stageEl.scrollTop = 0; stageEl.scrollLeft = 0; } });
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

  // Where the feed is running. On the web LMS it sits inside Docebo's iFrame widget. In the
  // Go.Learn app the widget page is shown in an in-app web view, where Docebo's web pages do not
  // load ("Please upgrade your browser"), so content must open through Go.Learn's own app links.
  const framed = (() => { try { return window.self !== window.top; } catch { return true; } })();
  const touch = matchMedia('(pointer: coarse)').matches;
  const inGoLearn = /golearn|go\.learn/i.test(navigator.userAgent) || (!framed && touch)
    || new URLSearchParams(location.search).get('app') === 'golearn';

  // Go.Learn app links, from Docebo's deep-link reference. The domain parameter (Base64 of the
  // platform host) is required: without it Go.Learn uses whatever platform URL it saved last, which
  // can be a different platform and shows a sign-in page that rejects the learner's credentials.
  function openUrl(it) {
    if (!inGoLearn) return it.doceboUrl;
    const id = encodeURIComponent(it.id);
    let host = '';
    try { host = new URL(it.doceboUrl).host; } catch { /* no host: link without domain */ }
    const q = host ? `?domain=${encodeURIComponent(btoa(host))}` : '';
    if (it.kind === 'course') return `golearn://course/${id}${q}`;
    if (it.kind === 'learning_plan') return `golearn://lp/${id}${q}`;
    return `golearn://asset/view/${id}${q}`;
  }
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
    star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2 6.3 20.3l1.2-6.4L2.8 9.5l6.4-.8z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 11.5 13 4v4.2C6.6 9 3.8 13.2 3 19c2.5-3.6 5.8-5.2 10-5.2V18z"/></svg>',
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
    api('/api/client-info', { method: 'POST', body: JSON.stringify({
      ua: navigator.userAgent, framed, touch, inGoLearn,
      vw: innerWidth, vh: innerHeight, sw: screen.width, sh: screen.height, dpr: devicePixelRatio,
      vvh: window.visualViewport ? Math.round(visualViewport.height) : null,
    }) }).catch(() => {});
  }

  // ---------- rendering ----------
  function statusChip(status) {
    if (!status) return '';
    const cls = /progress/i.test(status) ? 'prog' : /complet/i.test(status) ? 'done' : '';
    return `<span class="chip ${cls}">${esc(status)}</span>`;
  }

  function kindLabel(it) {
    // Docebo's raw type ("asset", "course") repeats the kind; only real subtypes are worth showing.
    if (!it.subtype || it.subtype.toLowerCase() === it.kind || it.subtype === 'learning_plan') it = { ...it, subtype: '' };
    if (it.kind === 'course') return it.subtype ? `${it.subtype} course` : 'Course';
    if (it.kind === 'learning_plan') return 'Learning plan';
    return it.subtype ? `${it.subtype} asset` : 'Asset';
  }

  function ctaLabel(it) {
    if (it.kind === 'asset') return inGoLearn ? 'Open' : 'Open in Docebo';
    if (/progress/i.test(it.status || '')) return 'Resume in Docebo';
    if (/complet/i.test(it.status || '')) return 'Review in Docebo';
    return 'Start in Docebo';
  }

  const canRateKind = (it) => it.kind === 'asset' || it.kind === 'course';
  const rateLabel = (it) => (it.myRating ? `${it.myRating}★` : 'Rate');

  // Bottom-left text block. Courses and learning plans get Docebo's description, a facts line,
  // the learner's progress and (plans) the courses inside, since they open in Docebo to play.
  function metaInner(it) {
    const rich = it.kind === 'course' || it.kind === 'learning_plan';
    const facts = (it.facts || []).length ? `<p class="facts">${it.facts.map(esc).join(' · ')}</p>` : '';
    const progress = typeof it.progress === 'number'
      ? `<div class="lpbar" role="progressbar" aria-valuenow="${it.progress}" aria-valuemin="0" aria-valuemax="100" aria-label="Plan progress"><i style="width:${it.progress}%"></i></div><p class="facts">${it.progress}% complete</p>` : '';
    const more = (it.courseCount || 0) - 3;
    const lp = (it.lpCourses || []).length
      ? `<ol class="lpcourses">${it.lpCourses.slice(0, 3).map((c) => `<li>${esc(c)}</li>`).join('')}${more > 0 ? `<li class="more">and ${more} more</li>` : ''}</ol>` : '';
    return `
        <div class="chips">${it.myStatus ? `<span class="chip st-${esc(it.myStatus.tone)}">${esc(it.myStatus.label)}</span>` : ''}<span class="chip kind">${esc(kindLabel(it))}</span>${statusChip(it.status)}${it.rating ? `<span class="chip">★ ${esc(it.rating)}</span>` : ''}</div>
        <p class="ttl">${esc(it.title)}</p>
        ${facts}
        ${it.description ? `<p class="desc${rich ? ' long' : ''}">${esc(it.description)}</p>` : ''}
        ${lp}
        ${progress}
        <a class="cta" href="${esc(openUrl(it))}" target="${inGoLearn ? '_self' : '_top'}">${ctaLabel(it)}</a>${it.myStatus?.canDelete ? '<button type="button" class="delmine">Delete</button>' : ''}
      `;
  }

  function cardHtml(it, i) {
    const [c1, c2] = PALETTE[i % PALETTE.length];
    const e = it.engagement;
    const visual = it.videoUrl
      ? `${it.thumbnailUrl ? `<div class="vbg" style="background-image:url('${esc(it.thumbnailUrl)}')"></div>` : '<div class="vbg"></div>'}<video preload="metadata" playsinline muted ${it.thumbnailUrl ? `poster="${esc(it.thumbnailUrl)}"` : ''} src="${esc(it.videoUrl)}"></video>
         <div class="playstate">${ICON.play}</div>
         <button type="button" class="mute" aria-label="Unmute">Sound off</button>`
      : `<div class="art" style="background:linear-gradient(160deg,${c1},${c2})">${it.thumbnailUrl ? `<img alt="" src="${esc(it.thumbnailUrl)}">` : ''}</div>
         <div class="big">${esc(it.title)}</div>`;
    const yt = it.youtubeId && !it.videoUrl;
    return `<article class="card${yt ? ' yt paused' : ''}" data-i="${i}" data-key="${esc(it.key)}" aria-label="${esc(it.title)}">
      ${visual}
      ${yt ? `<div class="playstate">${ICON.play}</div>` : ''}
      <div class="shade"></div>
      <div class="meta">${metaInner(it)}</div>
      <div class="rail">
        <button type="button" class="rbtn com" aria-label="Comments">${ICON.chat}<span>${e.comments}</span></button>
        ${canRateKind(it) ? `<button type="button" class="rbtn rate" aria-pressed="${!!it.myRating}" aria-label="Rate in Docebo">${ICON.star}<span>${rateLabel(it)}</span></button>` : ''}
        <button type="button" class="rbtn save" aria-pressed="${e.saved}" aria-label="Save">${ICON.save}<span>${e.saved ? 'Saved' : 'Save'}</span></button>
        <button type="button" class="rbtn share" aria-label="Share">${ICON.share}<span>Share</span></button>
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
    // Landscape videos in a portrait card: show the whole frame (letterboxed over a blurred copy of
    // the thumbnail) instead of cropping the sides. Portrait videos keep filling the screen.
    v.addEventListener('loadedmetadata', () => {
      card.classList.toggle('landscape', v.videoWidth > v.videoHeight * 1.05);
    });
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
            .then((r) => { if (r.trackedInDocebo) refreshRating(it); }).catch(() => {});
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
    if (it && (it.kind === 'course' || it.kind === 'learning_plan')) {
      if (!mediaReq.has(it.key)) {
        mediaReq.set(it.key, api(`/api/items/${encodeURIComponent(it.key)}/details`)
          .then((d) => applyDetails(it, d))
          .catch(() => {}));
      }
      return mediaReq.get(it.key);
    }
    if (!it || it.kind !== 'asset') return Promise.resolve();
    if (!mediaReq.has(it.key)) {
      mediaReq.set(it.key, api(`/api/assets/${encodeURIComponent(it.id)}/media`)
        .then((m) => applyMedia(it, m))
        .catch(() => {}));
    }
    return mediaReq.get(it.key);
  }
  function enrich(i) { enrichItem(items[i]); }

  function applyDetails(it, d) {
    if (d.description) it.description = d.description;
    it.facts = d.facts || [];
    if (d.status) it.status = d.status;
    if (typeof d.progress === 'number') it.progress = d.progress;
    if (d.courses?.length) { it.lpCourses = d.courses; it.courseCount = d.courseCount; }
    const card = cards[items.indexOf(it)];
    if (!card) return;
    if (d.thumbnailUrl && !it.thumbnailUrl) {
      it.thumbnailUrl = d.thumbnailUrl;
      const art = card.querySelector('.art');
      if (art && !art.querySelector('img')) art.insertAdjacentHTML('afterbegin', `<img alt="" src="${esc(it.thumbnailUrl)}">`);
    }
    card.querySelector('.meta').innerHTML = metaInner(it);
    card.classList.add('rich');
  }

  // Image assets: the whole picture, fitted to the card (no cropping) over a blurred copy of itself,
  // so any shape works on any screen. Tapping opens it full screen with pinch-zoom for detail.
  function showPicture(card, it) {
    card.classList.add('pic');
    const art = card.querySelector('.art');
    if (!art) return;
    art.innerHTML = `<div class="picbg" style="background-image:url('${esc(it.imageUrl)}')"></div>
      <img class="picfull" alt="${esc(it.title)}" src="${esc(it.imageUrl)}" decoding="async">`;
  }

  function openLightbox(it) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', it.title);
    box.innerHTML = `<button type="button" class="lbclose" aria-label="Close">×</button>
      <div class="lbscroll"><img alt="${esc(it.title)}" src="${esc(it.imageUrl)}"></div>`;
    const close = () => { box.remove(); feedEl.focus({ preventScroll: true }); };
    box.querySelector('.lbclose').addEventListener('click', close);
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    stageEl.appendChild(box);
    box.querySelector('.lbclose').focus({ preventScroll: true });
  }

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
    if (m.myRating !== undefined) it.myRating = m.myRating || 0;
    if (m.canRate !== undefined) it.canRate = m.canRate;
    if (typeof m.comments === 'number') it.engagement.comments = m.comments;
    if (m.subtype) it.subtype = m.subtype;
    if (m.thumbnailUrl && !it.thumbnailUrl) it.thumbnailUrl = m.thumbnailUrl;
    if (m.youtubeId && !it.videoUrl) it.youtubeId = m.youtubeId;
    if (m.imageUrl) it.imageUrl = m.imageUrl;
    const idx = items.indexOf(it);
    if (m.videoUrl && !it.videoUrl) {
      it.videoUrl = m.videoUrl;
      if (idx >= 0 && cards[idx]) replaceCard(idx);
      return;
    }
    const card = cards[idx];
    if (!card) return;
    const comSpan = card.querySelector('.com span');
    if (comSpan) comSpan.textContent = it.engagement.comments;
    const rateBtn = card.querySelector('.rate');
    if (rateBtn) { rateBtn.querySelector('span').textContent = rateLabel(it); rateBtn.setAttribute('aria-pressed', String(!!it.myRating)); }
    const chip = card.querySelector('.chips .kind');
    if (chip) chip.textContent = kindLabel(it);
    if (it.imageUrl && !card.classList.contains('pic')) showPicture(card, it);
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
    api(`/api/items/${encodeURIComponent(it.key)}/progress`, { method: 'POST', body: JSON.stringify({ percent: 1 }) })
      .then((r) => { if (r.trackedInDocebo) refreshRating(it); }).catch(() => {});
  }

  // Watching can make an item rateable in Docebo, so re-read the learner's rating permission.
  function refreshRating(it) {
    if (it.kind !== 'asset') return;
    api(`/api/assets/${encodeURIComponent(it.id)}/media`).then((m) => {
      if (m.canRate !== undefined) it.canRate = m.canRate;
      if (m.myRating !== undefined) it.myRating = m.myRating || 0;
      const btn = cards[items.indexOf(it)]?.querySelector('.rate span');
      if (btn) btn.textContent = rateLabel(it);
    }).catch(() => {});
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
    $('sheetSrc').textContent = '';
    renderComments(sheetList);
    openPanel(sheet);
    $('cinput').focus({ preventScroll: true });
    try {
      const r = await api(`/api/items/${encodeURIComponent(sheetItem.key)}/comments`);
      sheetList = r.comments;
      $('sheetSrc').textContent = r.source === 'docebo' ? 'Synced with Docebo' : '';
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

  // ---------- rate (Docebo rating) ----------
  let rateItem = null;
  // One panel at a time: opening Rate, Share or Comments closes the others.
  function openPanel(el) {
    for (const other of document.querySelectorAll('.sheet.open')) {
      if (other !== el) { other.classList.remove('open'); other.setAttribute('aria-hidden', 'true'); }
    }
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
  }
  function closePanel(el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); feedEl.focus({ preventScroll: true }); }

  function openRate(i) {
    const it = items[i];
    // Docebo keeps one rating per person and only allows rating once the item has been opened.
    if (it.myRating && it.canRate === false) return void toast(`You rated this ${it.myRating}★ in Docebo. Docebo keeps one rating per person.`);
    if (it.canRate === false) return void toast('Docebo lets you rate this once you have watched or opened it.');
    rateItem = it;
    $('rateTitle').textContent = `Rate "${rateItem.title}"`;
    $('stars').innerHTML = [1, 2, 3, 4, 5].map((n) =>
      `<button type="button" role="radio" aria-checked="${rateItem.myRating === n}" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}" class="${n <= (rateItem.myRating || 0) ? 'on' : ''}">${ICON.star}</button>`).join('');
    openPanel($('rateSheet'));
    $('stars').querySelector('button')?.focus({ preventScroll: true });
  }
  $('stars').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-n]');
    if (!b || !rateItem) return;
    const n = Number(b.dataset.n);
    try {
      const r = await api(`/api/items/${encodeURIComponent(rateItem.key)}/rating`, { method: 'POST', body: JSON.stringify({ rating: n }) });
      rateItem.myRating = r.rating || n;
      rateItem.canRate = r.canRate;
      const card = cards[items.indexOf(rateItem)];
      const btn = card?.querySelector('.rate');
      if (btn) { btn.querySelector('span').textContent = rateLabel(rateItem); btn.setAttribute('aria-pressed', 'true'); }
      closePanel($('rateSheet'));
      toast(`Rated ${rateItem.myRating}★ in Docebo.`);
    } catch (err) { toast(err.message); }
  });

  // ---------- share (copy link + Docebo invite to watch) ----------
  let shareItem = null;
  const picked = new Set();
  let shareUsers = [];
  function renderUsers(searched) {
    $('ulist').innerHTML = shareUsers.length
      ? shareUsers.map((u) => `<li><label><input type="checkbox" value="${u.id}" ${picked.has(u.id) ? 'checked' : ''}>
          <span class="who">${esc(u.name || u.username)}</span>${u.username && u.name ? `<span class="when">${esc(u.username)}</span>` : ''}</label></li>`).join('')
      : `<li class="empty">${searched ? 'Nobody matches that name.' : 'Type at least 3 letters of a colleague\'s name to find them.'}</li>`;
    $('sendInvite').disabled = !picked.size;
    $('sendInvite').textContent = picked.size ? `Send invite (${picked.size})` : 'Send invite';
  }
  async function loadUsers(q) {
    try {
      const found = (await api(`/api/items/${encodeURIComponent(shareItem.key)}/invite?q=${encodeURIComponent(q)}`)).users;
      // Keep people already ticked visible while searching for more.
      shareUsers = [...shareUsers.filter((u) => picked.has(u.id) && !found.some((f) => f.id === u.id)), ...found];
      renderUsers(!!q);
    } catch (err) { $('ulist').innerHTML = `<li class="empty">${esc(err.message)}</li>`; }
  }
  function openShare(i) {
    shareItem = items[i];
    picked.clear();
    shareUsers = [];
    $('linkBox').hidden = true;
    $('copyLink').textContent = 'Copy link';
    const invite = shareItem.kind === 'asset';
    $('inviteBox').hidden = !invite;
    $('shareNote').hidden = invite;
    $('inviteSearch').value = '';
    if (invite) { $('ulist').innerHTML = '<li class="empty">Loading suggestions</li>'; loadUsers(''); }
    openPanel($('shareSheet'));
  }
  $('copyLink').addEventListener('click', async () => {
    const link = shareItem?.doceboUrl || '';
    try {
      await navigator.clipboard.writeText(link);
      $('copyLink').textContent = 'Link copied';
    } catch {
      const box = $('linkBox');
      box.hidden = false;
      box.value = link;
      box.select();
      $('copyLink').textContent = 'Press Ctrl+C or Cmd+C to copy';
    }
  });
  let invTimer;
  $('inviteSearch').addEventListener('input', () => {
    clearTimeout(invTimer);
    const q = $('inviteSearch').value.trim();
    invTimer = setTimeout(() => { if (q.length === 0 || q.length >= 3) loadUsers(q); }, 250);
  });
  $('ulist').addEventListener('change', (e) => {
    const id = Number(e.target.value);
    if (e.target.checked) picked.add(id); else picked.delete(id);
    renderUsers();
  });
  $('sendInvite').addEventListener('click', async () => {
    if (!picked.size || !shareItem) return;
    $('sendInvite').disabled = true;
    try {
      const r = await api(`/api/items/${encodeURIComponent(shareItem.key)}/invite`, { method: 'POST', body: JSON.stringify({ userIds: [...picked] }) });
      closePanel($('shareSheet'));
      toast(`Invited ${r.invited} ${r.invited === 1 ? 'person' : 'people'} to watch. Docebo will notify them.`);
    } catch (err) { toast(err.message); $('sendInvite').disabled = false; }
  });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closePanel($(b.dataset.close))));
  [$('rateSheet'), $('shareSheet')].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(el); }));

  // ---------- Save = Docebo "Add to playlist" ----------
  let plItem = null;
  let playlists = [];
  function renderPlaylists() {
    $('plList').innerHTML = playlists.length
      ? playlists.map((p) => `<li><label><input type="checkbox" value="${p.id}" ${p.contains ? 'checked' : ''}>
          <span class="who">${esc(p.title)}</span>${p.private ? '<span class="when">Private</span>' : ''}</label></li>`).join('')
      : '<li class="empty">No playlists yet. Create one below.</li>';
  }
  async function syncSaved() {
    // The bookmark shows "Saved" when the item is in at least one Docebo playlist.
    const any = playlists.some((p) => p.contains);
    const e = plItem.engagement;
    const btn = cards[items.indexOf(plItem)]?.querySelector('.save');
    if (any !== e.saved) {
      try { await api(`/api/items/${encodeURIComponent(plItem.key)}/save`, { method: 'POST', body: JSON.stringify({ on: any }) }); } catch { /* cosmetic */ }
      e.saved = any;
    }
    if (btn) { btn.setAttribute('aria-pressed', String(any)); btn.querySelector('span').textContent = any ? 'Saved' : 'Save'; }
  }
  async function openPlaylists(i) {
    plItem = items[i];
    playlists = [];
    $('plList').innerHTML = '<li class="empty">Loading your playlists</li>';
    $('newPlName').value = '';
    openPanel($('plSheet'));
    try {
      playlists = (await api(`/api/items/${encodeURIComponent(plItem.key)}/playlists`)).playlists;
      renderPlaylists();
      syncSaved();
    } catch (err) { $('plList').innerHTML = `<li class="empty">${esc(err.message)}</li>`; }
  }
  $('plList').addEventListener('change', async (e) => {
    const box = e.target;
    const p = playlists.find((x) => x.id === Number(box.value));
    if (!p) return;
    box.disabled = true;
    try {
      await api(`/api/items/${encodeURIComponent(plItem.key)}/playlists`, { method: 'POST', body: JSON.stringify({ playlistId: p.id, on: box.checked }) });
      p.contains = box.checked;
      toast(box.checked ? `Added to "${p.title}".` : `Removed from "${p.title}".`);
      syncSaved();
    } catch (err) { box.checked = !box.checked; toast(err.message); }
    box.disabled = false;
  });
  $('newPl').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('newPlName').value.trim();
    if (!title || !plItem) return;
    try {
      const r = await api(`/api/items/${encodeURIComponent(plItem.key)}/playlists/new`, { method: 'POST', body: JSON.stringify({ title, private: $('newPlPrivate').checked }) });
      playlists.unshift({ id: r.id, title, private: $('newPlPrivate').checked, contains: true });
      $('newPlName').value = '';
      renderPlaylists();
      syncSaved();
      toast(`Created "${title}" and added this item.`);
    } catch (err) { toast(err.message); }
  });

  // ---------- + Share content (Docebo contribute) ----------
  let postTab = 'upload';
  let linkThumb = '';
  let channelsLoaded = false;
  function setTab(tab) {
    postTab = tab;
    document.querySelectorAll('#postSheet .tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('#postForm [data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  }
  async function openPost() {
    $('postForm').reset();
    $('postFileLabel').textContent = 'Choose a video, image or document';
    $('linkPrev').hidden = true;
    linkThumb = '';
    $('postProgress').hidden = true;
    $('postError').hidden = true;
    $('postSubmit').disabled = false;
    setTab('upload');
    openPanel($('postSheet'));
    if (!channelsLoaded) {
      try {
        const { channels } = await api('/api/contribute/channels');
        $('postChannels').innerHTML = channels.length
          ? channels.map((c) => `<li><label><input type="checkbox" value="${c.id}"><span class="who">${esc(c.name)}</span></label></li>`).join('')
          : '<li class="empty">No channels available. It will go to your own channel.</li>';
        channelsLoaded = true;
      } catch (err) { $('postChannels').innerHTML = `<li class="empty">${esc(err.message)}</li>`; }
    } else {
      $('postChannels').querySelectorAll('input').forEach((x) => { x.checked = false; });
    }
  }
  $('postBtn').addEventListener('click', openPost);
  document.querySelectorAll('#postSheet .tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('postFile').addEventListener('change', () => {
    const f = $('postFile').files[0];
    if (!f) return;
    $('postFileLabel').textContent = `${f.name} (${(f.size / 1048576).toFixed(1)} MB)`;
    if (!$('postTitle').value) $('postTitle').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  });
  let metaTimer;
  $('postUrl').addEventListener('input', () => {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(async () => {
      const u = $('postUrl').value.trim();
      if (!/^https:\/\/\S+\.\S+/.test(u)) return;
      try {
        const m = await api(`/api/contribute/meta?url=${encodeURIComponent(u)}`);
        if (m.title && !$('postTitle').value) $('postTitle').value = m.title;
        if (m.description && !$('postDesc').value) $('postDesc').value = m.description.slice(0, 2000);
        linkThumb = m.image || '';
        $('linkPrev').hidden = !linkThumb;
        $('linkPrev').innerHTML = linkThumb ? `<img alt="" src="${esc(linkThumb)}">` : '';
      } catch { /* preview is optional */ }
    }, 500);
  });

  function uploadFile(f) {
    // XHR (not fetch) so the learner sees upload progress.
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/contribute/upload?filename=${encodeURIComponent(f.name)}&mime=${encodeURIComponent(f.type || 'application/octet-stream')}`);
      x.setRequestHeader('Authorization', `Bearer ${token}`);
      x.upload.onprogress = (e) => { if (e.lengthComputable) $('postProgress').firstElementChild.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; };
      x.onload = () => {
        let body = {};
        try { body = JSON.parse(x.responseText); } catch { /* keep empty */ }
        if (x.status >= 200 && x.status < 300 && body.storedName) resolve(body.storedName);
        else reject(new Error(body.error || `Upload failed (${x.status})`));
      };
      x.onerror = () => reject(new Error('Upload failed. Check the connection and try again.'));
      x.send(f);
    });
  }

  $('postForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('postTitle').value.trim();
    const description = $('postDesc').value.trim();
    const channels = [...$('postChannels').querySelectorAll('input:checked')].map((x) => Number(x.value));
    if (!title) return void toast('Add a title.');
    let postResult = {};
    $('postError').hidden = true;
    $('postSubmit').disabled = true;
    try {
      if (postTab === 'link') {
        const url = $('postUrl').value.trim();
        if (!/^https:\/\//.test(url)) throw new Error('Enter a full https:// link.');
        $('postSubmit').textContent = 'Publishing';
        postResult = await api('/api/contribute', { method: 'POST', body: JSON.stringify({ type: 'link', url, title, description, thumbnail: linkThumb, channels }) });
      } else {
        const f = $('postFile').files[0];
        if (!f) throw new Error('Choose a file to upload.');
        if (f.size > 95 * 1048576) throw new Error('Files up to 95 MB can be shared from the feed. Use Docebo for larger files.');
        $('postProgress').hidden = false;
        $('postSubmit').textContent = 'Uploading';
        const storedName = await uploadFile(f);
        $('postSubmit').textContent = 'Publishing';
        postResult = await api('/api/contribute', { method: 'POST', body: JSON.stringify({ type: 'file', storedName, originalName: f.name, mime: f.type, title, description, channels }) });
      }
      closePanel($('postSheet'));
      mine = null;
      if (postResult.channelErrors) toast(`Shared, but some channels refused it: ${postResult.channelErrors}`);
      else if (!postResult.published) toast('Saved in Docebo as a draft, but Docebo did not let you publish it. Open it in My Channel to publish.');
      else toast(`Published to Docebo.${postTab === 'upload' ? ' Videos take a few minutes to process.' : ''} Track it under My posts.`);
    } catch (err) {
      $('postError').hidden = false;
      $('postError').textContent = err.message;
      $('postProgress').hidden = true;
    }
    $('postSubmit').disabled = false;
    $('postSubmit').textContent = 'Publish';
  });
  [$('plSheet'), $('postSheet')].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(el); }));

  // ---------- My posts: delete own contribution ----------
  async function deleteMine(it) {
    if (!confirm(`Delete "${it.title}" from Docebo? This removes it from every channel and cannot be undone.`)) return;
    try {
      await api(`/api/mine/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
      mine = (mine || []).filter((x) => x.key !== it.key);
      all = all.filter((x) => x.key !== it.key);
      applyFilter();
      toast(`Deleted "${it.title}".`);
    } catch (err) { toast(err.message); }
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
    if (save) {
      if (it.kind === 'asset' || it.kind === 'course') return void openPlaylists(i);
      toggleFlag(save, it, 'save');
      return void toast(it.engagement.saved
        ? 'Removed from Saved.'
        : 'Saved in the feed. Docebo playlists only hold videos, files and courses, so learning plans cannot be added to one.');
    }
    if (e.target.closest('.com')) return void openSheet(i);
    if (e.target.closest('.rate')) return void openRate(i);
    if (e.target.closest('.share')) return void openShare(i);
    if (e.target.closest('.delmine')) return void deleteMine(it);
    if (e.target.closest('.mute')) return void setMuted(!muted);
    if (e.target.closest('a')) return;
    if (it.imageUrl) return void openLightbox(it);
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
    const id = del.closest('li').dataset.id;
    try {
      await api(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
  const TYPES = [['all', 'All'], ['videos', 'Videos'], ['courses', 'Courses'], ['saved', 'Saved'], ['mine', 'My posts']];
  let mine = null; // the learner's contributions, loaded when "My posts" is opened

  function isVideo(it) { return !!(it.videoUrl || it.youtubeId || /video/i.test(it.subtype || '')); }

  function matches(it) {
    if (filter.type === 'mine') { /* the source list is already the learner's own posts */ }
    else if (filter.type === 'videos' && !isVideo(it)) return false;
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
    if (filter.type === 'mine') return 'You have not shared anything yet. Tap + to share a video, file or link.';
    return 'Nothing here yet.';
  }

  function applyFilter() {
    if (cur >= 0 && cards[cur]) {
      cards[cur].querySelector('video')?.pause();
      stopYouTube(cards[cur]);
    }
    cur = -1;
    items = (filter.type === 'mine' ? mine || [] : all).filter(matches);
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
    if (filter.type === 'mine') {
      feedEl.innerHTML = '';
      statusEl.hidden = false;
      statusEl.textContent = 'Loading your posts';
      try { mine = (await api('/api/mine')).items; } catch (err) { mine = []; toast(err.message); }
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
