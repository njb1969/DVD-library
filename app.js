'use strict';
/*
 * DVD Library — front end (plain JavaScript, no build step)
 *
 *  Library   poster grid, instant search across title/cast/director/genre/shelf/notes, filters, sort
 *  Card      one disc's catalogue card: details, shelf, loan, edit, change match, refresh, delete
 *  Adder     add discs three ways — scan barcode, photograph cover (OCR), type title — then confirm
 *
 * Barcodes: the browser's built-in BarcodeDetector when present (Android Chrome), otherwise ZXing.
 * Cover text: Tesseract.js, loaded only the first time a cover photo is taken.
 * Everything that needs a key goes through api.php.
 */

const LIBS = {
  zxing: 'https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.1/umd/zxing-browser.min.js',
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js',
};
const TMDB_IMG = 'https://image.tmdb.org/t/p/';

// ───────────────────────────── small helpers ─────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('dvdlib.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('dvdlib.' + key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const scripts = {};
function loadScript(url) {
  if (!scripts[url]) {
    scripts[url] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = () => { delete scripts[url]; reject(new Error('Could not download a helper library. Check the tablet\'s internet connection.')); };
      document.head.appendChild(s);
    });
  }
  return scripts[url];
}

/** Check digit test for EAN-8, UPC-A and EAN-13. */
function checksumOk(code) {
  if (!/^(\d{8}|\d{12}|\d{13})$/.test(code)) return false;
  const n = code.length;
  let sum = 0;
  for (let i = 0; i < n - 1; i++) sum += Number(code[i]) * ((n - 1 - i) % 2 === 1 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(code[n - 1]);
}

function seasonLabel(season) {
  if (!season) return '';
  return /^\d+$/.test(season) ? `Season ${season}` : season;
}

function typeLabel(t) {
  return t === 'tv' ? 'TV' : t === 'movie' ? 'Film' : 'Other';
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 1320;
    g.gain.value = 0.08;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.09);
  } catch { /* no sound available */ }
  if (navigator.vibrate) navigator.vibrate(60);
}

let toastTimer = null;
function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 3000);
}

// ───────────────────────────── server ─────────────────────────────

async function api(action, { params = {}, body = null } = {}) {
  const qs = new URLSearchParams({ action, ...params });
  const opt = { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: { 'X-DVDLib': '1', Accept: 'application/json' } };
  if (body) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('api.php?' + qs, opt);
  } catch {
    throw new Error('Can\'t reach the server. Check the tablet\'s Wi-Fi.');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`The server sent something unexpected (HTTP ${res.status}). Is PHP running for this folder?`);
  }
  if (!data.ok) {
    if (data.signin) showLogin();
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ───────────────────────────── state ─────────────────────────────

const state = {
  status: null,
  items: [],
  filters: { q: '', shelf: '', type: '', format: '', loan: false, sort: store.get('sort', 'title') },
  detailId: null,
  editing: false,
  editPhoto: null,      // new photo picked while editing (data URL)
  editRemovePhoto: false,
  editDraft: null,      // typed-in values kept while the edit form redraws
};

function byId(id) {
  return state.items.find((it) => it.id === id) || null;
}

function prepare(it) {
  it._hay = norm([it.title, it.original_title, it.year, it.genres, it.directors, it.cast_list, it.collection,
    it.location, it.format, it.season ? seasonLabel(it.season) : '', it.notes, it.loaned_to, it.barcode,
    typeLabel(it.media_type)].join(' \u0001 '));
  it._sort = norm(it.title).replace(/^(the|a|an)\s+/, '');
  return it;
}

function upsertItem(item) {
  prepare(item);
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item; else state.items.push(item);
  refreshFilterOptions();
  renderLibrary();
}

function shelves() {
  return [...new Set(state.items.map((it) => it.location).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function coverSrc(it, size = 'w342') {
  const photo = it.cover_photo ? state.status.covers_url + it.cover_photo : null;
  if (it.use_photo && photo) return photo;
  if (it.poster_path) return TMDB_IMG + size + it.poster_path;
  return photo;
}

function coverHtml(it, size) {
  const src = coverSrc(it, size);
  return src ? `<img src="${esc(src)}" alt="" loading="lazy">` : `<div class="blank">${esc(it.title)}</div>`;
}

// ───────────────────────────── screens ─────────────────────────────

function showOnly(id) {
  for (const s of ['screen-setup', 'screen-login', 'app']) $('#' + s).hidden = s !== id;
}

function showSetup(problems) {
  $('#setup-problems').innerHTML = problems.map((p) => `<li>${esc(p)}</li>`).join('');
  showOnly('screen-setup');
}

function showLogin() {
  closeAdder({ swap: true });
  closeDetail({ swap: true });
  showOnly('screen-login');
  setTimeout(() => $('#login-pw').focus(), 50);
}

async function enterApp() {
  showOnly('app');
  await loadLibrary();
}

async function loadLibrary() {
  $('#library').innerHTML = '<p class="empty"><span class="spinner"></span>Opening the library…</p>';
  try {
    const data = await api('list');
    state.items = data.items.map(prepare);
    refreshFilterOptions();
    renderLibrary();
  } catch (e) {
    $('#library').innerHTML = `<div class="empty"><h2>The library didn't open</h2><p>${esc(e.message)}</p>
      <button class="btn" type="button" data-act="reload">Try again</button></div>`;
  }
}

// ───────────────────────────── library view ─────────────────────────────

function refreshFilterOptions() {
  const f = state.filters;
  const list = shelves();
  const hasUnshelved = state.items.some((it) => !it.location);
  $('#f-shelf').innerHTML = '<option value="">All shelves</option>'
    + list.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')
    + (hasUnshelved ? '<option value="__none">Not shelved</option>' : '');
  if (f.shelf && f.shelf !== '__none' && !list.includes(f.shelf)) f.shelf = '';
  $('#f-shelf').value = f.shelf;

  const formats = [...new Set(state.items.map((it) => it.format).filter(Boolean))].sort();
  $('#f-format').innerHTML = '<option value="">All formats</option>' + formats.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  if (f.format && !formats.includes(f.format)) f.format = '';
  $('#f-format').value = f.format;
  $('#f-format').hidden = formats.length < 2;

  $('#shelf-list').innerHTML = list.map((s) => `<option value="${esc(s)}"></option>`).join('');
  $('#f-sort').value = f.sort;
}

function filteredItems() {
  const f = state.filters;
  const words = norm(f.q).split(/\s+/).filter(Boolean);
  const out = state.items.filter((it) =>
    (!f.shelf || (f.shelf === '__none' ? !it.location : it.location === f.shelf))
    && (!f.type || it.media_type === f.type)
    && (!f.format || it.format === f.format)
    && (!f.loan || !!it.loaned_to)
    && words.every((w) => it._hay.includes(w)));

  const byTitle = (a, b) => a._sort.localeCompare(b._sort) || (a.year || 0) - (b.year || 0) || String(a.season || '').localeCompare(String(b.season || ''), undefined, { numeric: true });
  const sorters = {
    title: byTitle,
    added: (a, b) => String(b.added_at).localeCompare(String(a.added_at)),
    year: (a, b) => (b.year || 0) - (a.year || 0) || byTitle(a, b),
    shelf: (a, b) => (a.location || '￿').localeCompare(b.location || '￿') || byTitle(a, b),
  };
  return out.sort(sorters[f.sort] || byTitle);
}

function tileHtml(it) {
  const sub = [it.year, seasonLabel(it.season)].filter(Boolean).join(', ');
  return `<button class="disc" type="button" data-id="${it.id}">
    <div class="cover">${coverHtml(it)}
      ${it.format && it.format !== 'DVD' ? `<span class="tag">${esc(it.format)}</span>` : ''}
      ${it.loaned_to ? '<span class="loan">On loan</span>' : ''}
    </div>
    <div class="disc-title">${esc(it.title)}</div>
    ${sub ? `<div class="disc-sub">${esc(sub)}</div>` : ''}
  </button>`;
}

function renderLibrary() {
  const lib = $('#library');
  const total = state.items.length;
  const list = filteredItems();
  const f = state.filters;
  const filtering = f.q || f.shelf || f.type || f.format || f.loan;
  $('#count').textContent = filtering ? `${list.length} of ${plural(total, 'disc', 'discs')}` : plural(total, 'disc', 'discs');

  if (!total) {
    lib.innerHTML = `<div class="empty"><h2>Your shelves are empty</h2>
      <p>Scan a barcode, photograph a cover or type a title to add your first disc.</p>
      <button class="btn btn-brass" type="button" data-act="add">Add your first disc</button></div>`;
    return;
  }
  if (!list.length) {
    lib.innerHTML = `<div class="empty"><h2>Nothing matches${f.q ? ` “${esc(f.q)}”` : ''}</h2>
      <p>Try fewer words, or clear the filters.</p>
      <button class="btn" type="button" data-act="clear-filters">Clear search and filters</button></div>`;
    return;
  }
  if (f.sort === 'shelf') {
    const groups = new Map();
    for (const it of list) {
      const key = it.location || 'Not shelved';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    lib.innerHTML = [...groups].map(([shelf, items]) =>
      `<h2 class="shelf-heading">${esc(shelf)}<small>${plural(items.length, 'disc', 'discs')}</small></h2>
       <div class="grid">${items.map(tileHtml).join('')}</div>`).join('');
  } else {
    lib.innerHTML = `<div class="grid">${list.map(tileHtml).join('')}</div>`;
  }
}

function wireLibrary() {
  let qTimer = null;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.filters.q = e.target.value; renderLibrary(); }, 120);
  });
  $('#f-shelf').addEventListener('change', (e) => { state.filters.shelf = e.target.value; renderLibrary(); });
  $('#f-type').addEventListener('change', (e) => { state.filters.type = e.target.value; renderLibrary(); });
  $('#f-format').addEventListener('change', (e) => { state.filters.format = e.target.value; renderLibrary(); });
  $('#f-sort').addEventListener('change', (e) => { state.filters.sort = e.target.value; store.set('sort', e.target.value); renderLibrary(); });
  $('#f-loan').addEventListener('change', (e) => { state.filters.loan = e.target.checked; renderLibrary(); });

  $('#library').addEventListener('click', (e) => {
    const tile = e.target.closest('.disc');
    if (tile) return openDetail(Number(tile.dataset.id));
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add') openAdder();
    if (act === 'reload') loadLibrary();
    if (act === 'clear-filters') {
      Object.assign(state.filters, { q: '', shelf: '', type: '', format: '', loan: false });
      $('#q').value = '';
      $('#f-type').value = '';
      $('#f-loan').checked = false;
      refreshFilterOptions();
      renderLibrary();
    }
  });

  $('#btn-add').addEventListener('click', () => openAdder());
}

// ───────────────────────────── back button / overlays ─────────────────────────────
// Each open overlay adds a history entry, so the tablet's Back button closes it instead of leaving the app.

const Nav = {
  depth: 0,
  ignoreNext: false,
  push() { history.pushState({ dvdlib: true }, ''); this.depth++; },
  pop() {
    if (this.depth > 0) {
      this.depth--;
      this.ignoreNext = true;
      history.back();
    }
  },
};

window.addEventListener('popstate', () => {
  if (Nav.ignoreNext) { Nav.ignoreNext = false; return; }
  if (Nav.depth === 0) return;
  Nav.depth--;
  if (!$('#modal').hidden) {
    closeModal(null);
    Nav.push();                    // the overlay underneath is still open
    return;
  }
  if (!$('#adder').hidden) closeAdder({ fromHistory: true });
  else if (!$('#detail').hidden) closeDetail({ fromHistory: true });
});

// ───────────────────────────── dialogs ─────────────────────────────

let modalResolve = null;
function ask({ title, message = '', input = null, ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    const m = $('#modal');
    m.innerHTML = `<form class="modal" novalidate>
      <h3>${esc(title)}</h3>
      ${message ? `<p>${esc(message)}</p>` : ''}
      ${input ? `<input name="value" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off">` : ''}
      <div class="panel-actions">
        ${cancel ? `<button type="button" class="btn btn-quiet" data-act="cancel">${esc(cancel)}</button>` : ''}
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-brass'}">${esc(ok)}</button>
      </div></form>`;
    m.hidden = false;
    const form = $('form', m);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      closeModal(input ? form.value.value.trim() : true);
    });
    $('[data-act="cancel"]', m)?.addEventListener('click', () => closeModal(null));
    setTimeout(() => (input ? form.value : $('[type="submit"]', form)).focus(), 30);
  });
}

function closeModal(result) {
  $('#modal').hidden = true;
  $('#modal').innerHTML = '';
  const r = modalResolve;
  modalResolve = null;
  if (r) r(result);
}

// ───────────────────────────── catalogue card ─────────────────────────────

function openDetail(id, { swap = false } = {}) {
  const it = byId(id);
  if (!it) return;
  state.detailId = id;
  state.editing = false;
  state.editPhoto = null;
  state.editRemovePhoto = false;
  renderCard();
  if ($('#detail').hidden) {
    $('#detail').hidden = false;
    if (!swap) Nav.push();
  }
  $('#card').scrollTop = 0;
}

function closeDetail({ fromHistory = false, swap = false } = {}) {
  if ($('#detail').hidden) return;
  $('#detail').hidden = true;
  state.detailId = null;
  state.editing = false;
  if (!fromHistory && !swap) Nav.pop();
}

function renderCard() {
  const it = byId(state.detailId);
  if (!it) return closeDetail();
  const card = $('#card');
  if (state.editing) {
    card.innerHTML = editFormHtml(it);
    const form = $('#edit-form');
    if (form && state.editDraft) {
      for (const [k, v] of Object.entries(state.editDraft)) {
        const el = form.elements[k];
        if (el && el.type !== 'checkbox' && el.type !== 'file') el.value = v;
      }
    }
    return;
  }
  state.editDraft = null;
  const facts = [
    it.year,
    it.runtime ? `${it.runtime} min${it.media_type === 'tv' ? ' episodes' : ''}` : '',
    it.certification,
    it.rating ? `TMDB ${it.rating.toFixed(1)}` : '',
    typeLabel(it.media_type),
  ].filter(Boolean);
  const what = [it.format || 'DVD', it.discs ? plural(it.discs, 'disc', 'discs') : '', seasonLabel(it.season)].filter(Boolean).join(', ');
  const added = it.added_at ? new Date(it.added_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const rows = [
    [it.media_type === 'tv' ? 'Created by' : 'Directed by', it.directors],
    ['Starring', it.cast_list],
    ['Genres', it.genres],
    ['Collection', it.collection],
    ['Notes', it.notes],
    ['Barcode', it.barcode],
    ['Added', added],
  ].filter(([, v]) => v);

  card.innerHTML = `
    <div class="card-top"><span></span><button class="btn" type="button" data-act="close">Close</button></div>
    <div class="card-main">
      <div class="card-poster">${coverHtml(it, 'w500')}</div>
      <div>
        <h2 id="card-title">${esc(it.title)}</h2>
        ${it.original_title && it.original_title !== it.title ? `<p class="orig">${esc(it.original_title)}</p>` : ''}
        <div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
        <div class="shelfmark">
          <div class="where">${it.location ? esc(it.location) : '<span class="nowhere">No shelf recorded</span>'}</div>
          <div class="what">${esc(what)}</div>
        </div>
        ${it.loaned_to ? `<div><span class="stamp">On loan to ${esc(it.loaned_to)}</span></div>` : ''}
      </div>
    </div>
    ${it.overview ? `<p class="card-overview">${esc(it.overview)}</p>` : ''}
    ${rows.length ? `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    <div class="card-links">
      ${it.imdb_id ? `<a href="https://www.imdb.com/title/${esc(it.imdb_id)}/" target="_blank" rel="noopener">IMDb page</a>` : ''}
      ${it.tmdb_id ? `<a href="https://www.themoviedb.org/${it.media_type === 'tv' ? 'tv' : 'movie'}/${it.tmdb_id}" target="_blank" rel="noopener">TMDB page</a>` : ''}
    </div>
    <div class="card-actions">
      <button class="btn" type="button" data-act="edit">Edit details</button>
      ${it.loaned_to ? '<button class="btn" type="button" data-act="returned">Mark returned</button>' : '<button class="btn" type="button" data-act="lend">Lend</button>'}
      <button class="btn" type="button" data-act="rematch">Change match</button>
      ${it.tmdb_id ? '<button class="btn" type="button" data-act="refresh">Refresh details</button>' : ''}
      <button class="btn btn-danger" type="button" data-act="delete">Delete</button>
    </div>`;
}

function editFormHtml(it) {
  const manual = !it.tmdb_id;
  const photoShown = state.editRemovePhoto ? null : (state.editPhoto || (it.cover_photo ? state.status.covers_url + it.cover_photo : null));
  const mediaOpts = ['movie', 'tv', 'other'].map((t) => `<option value="${t}" ${it.media_type === t ? 'selected' : ''}>${typeLabel(t)}</option>`).join('');
  return `
    <div class="card-top"><h2 id="card-title" style="font-size:26px;margin:0">Edit ${esc(it.title)}</h2>
      <button class="btn" type="button" data-act="cancel-edit">Cancel</button></div>
    <form id="edit-form" novalidate>
      ${manual ? `
        <label class="field wide"><span>Title</span><input name="title" value="${esc(it.title)}" required></label>
        <label class="field"><span>Year</span><input name="year" inputmode="numeric" value="${esc(it.year || '')}"></label>
        <label class="field"><span>Kind</span><select name="media_type">${mediaOpts}</select></label>
        <label class="field"><span>Genres</span><input name="genres" value="${esc(it.genres || '')}"></label>
        <label class="field"><span>Director or creator</span><input name="directors" value="${esc(it.directors || '')}"></label>
        <label class="field wide"><span>Starring</span><input name="cast_list" value="${esc(it.cast_list || '')}"></label>
        <label class="field"><span>Running time (minutes)</span><input name="runtime" inputmode="numeric" value="${esc(it.runtime || '')}"></label>
        <label class="field"><span>Classification</span><input name="certification" value="${esc(it.certification || '')}" placeholder="e.g. M"></label>
        <label class="field wide"><span>Summary</span><textarea name="overview">${esc(it.overview || '')}</textarea></label>
      ` : ''}
      <label class="field"><span>Shelf</span><input name="location" list="shelf-list" value="${esc(it.location || '')}" autocomplete="off"></label>
      <label class="field"><span>Format</span><input name="format" list="format-list" value="${esc(it.format || 'DVD')}" autocomplete="off"></label>
      <label class="field"><span>Season or volume</span><input name="season" value="${esc(it.season || '')}" placeholder="e.g. 2, or Complete"></label>
      <label class="field"><span>Number of discs</span><input name="discs" inputmode="numeric" value="${esc(it.discs || '')}"></label>
      <label class="field"><span>Barcode</span><input name="barcode" inputmode="numeric" value="${esc(it.barcode || '')}"></label>
      <label class="field"><span>On loan to</span><input name="loaned_to" value="${esc(it.loaned_to || '')}" autocomplete="off"></label>
      <label class="field wide"><span>Notes</span><textarea name="notes" placeholder="Edition, condition, extras…">${esc(it.notes || '')}</textarea></label>
      <div class="field wide"><span>My photo of the cover</span>
        <div class="photo-row">
          ${photoShown ? `<img src="${esc(photoShown)}" alt="Your cover photo">` : ''}
          <label class="btn" for="edit-photo">${photoShown ? 'Take a new photo' : 'Add a photo'}</label>
          <input id="edit-photo" type="file" accept="image/*" capture="environment" hidden>
          ${photoShown ? '<button class="btn" type="button" data-act="remove-photo">Remove photo</button>' : ''}
          ${photoShown && it.poster_path ? `<label class="check"><input type="checkbox" name="use_photo" ${it.use_photo ? 'checked' : ''}> Show my photo instead of the poster</label>` : ''}
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" type="button" data-act="cancel-edit">Cancel</button>
        <button class="btn btn-primary" type="submit">Save changes</button>
      </div>
    </form>`;
}

/** Keep what has been typed so far when the edit form redraws (e.g. after picking a photo). */
function keepEditValues() {
  const form = $('#edit-form');
  state.editDraft = form ? Object.fromEntries([...new FormData(form)].filter(([, v]) => typeof v === 'string')) : null;
}

async function saveCard(body, doneMessage) {
  try {
    const r = await api('save', { body: { id: state.detailId, ...body } });
    upsertItem(r.item);
    state.editing = false;
    state.editPhoto = null;
    state.editRemovePhoto = false;
    renderCard();
    if (doneMessage) toast(doneMessage);
  } catch (e) {
    toast(e.message, true);
  }
}

function wireCard() {
  const card = $('#card');
  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') closeDetail(); });

  card.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const it = byId(state.detailId);
    if (!it) return;
    if (act === 'close') closeDetail();
    if (act === 'edit') { state.editing = true; state.editDraft = null; renderCard(); }
    if (act === 'cancel-edit') { state.editing = false; state.editPhoto = null; state.editRemovePhoto = false; renderCard(); }
    if (act === 'remove-photo') { keepEditValues(); state.editPhoto = null; state.editRemovePhoto = true; renderCard(); }
    if (act === 'lend') {
      const who = await ask({ title: `Lend ${it.title}`, message: 'Who is borrowing it?', input: { placeholder: 'Name' }, ok: 'Lend' });
      if (who) saveCard({ fields: { loaned_to: who } }, `Lent to ${who}`);
    }
    if (act === 'returned') saveCard({ fields: { loaned_to: '' } }, `${it.title} is back on the shelf`);
    if (act === 'refresh') {
      try {
        const r = await api('refresh', { body: { id: it.id } });
        upsertItem(r.item);
        renderCard();
        toast('Details refreshed from TMDB');
      } catch (err) { toast(err.message, true); }
    }
    if (act === 'rematch') {
      closeDetail({ swap: true });
      openAdder({ rematch: it, swap: true });
    }
    if (act === 'delete') {
      const yes = await ask({ title: `Delete ${it.title}?`, message: 'It will be removed from the library. This can\'t be undone.', ok: 'Delete', danger: true });
      if (!yes) return;
      try {
        await api('delete', { body: { id: it.id } });
        state.items = state.items.filter((x) => x.id !== it.id);
        closeDetail();
        refreshFilterOptions();
        renderLibrary();
        toast(`Deleted ${it.title}`);
      } catch (err) { toast(err.message, true); }
    }
  });

  card.addEventListener('change', async (e) => {
    if (e.target.id !== 'edit-photo' || !e.target.files[0]) return;
    keepEditValues();
    try {
      const canvas = await fileToCanvas(e.target.files[0], 900);
      state.editPhoto = canvas.toDataURL('image/jpeg', 0.82);
      state.editRemovePhoto = false;
      renderCard();
    } catch (err) { toast(err.message, true); }
  });

  card.addEventListener('submit', (e) => {
    if (e.target.id !== 'edit-form') return;
    e.preventDefault();
    const it = byId(state.detailId);
    const fd = new FormData(e.target);
    const v = (k) => (fd.get(k) ?? '').toString().trim();
    const body = {
      fields: {
        location: v('location'), format: v('format') || 'DVD', season: v('season'), discs: v('discs'),
        barcode: v('barcode'), loaned_to: v('loaned_to'), notes: v('notes'), use_photo: fd.get('use_photo') === 'on',
      },
    };
    if (!it.tmdb_id) {
      if (!v('title')) return toast('A title is needed.', true);
      body.manual = {
        title: v('title'), year: v('year'), media_type: v('media_type'), genres: v('genres'), directors: v('directors'),
        cast_list: v('cast_list'), runtime: v('runtime'), certification: v('certification'), overview: v('overview'),
      };
    }
    if (state.editPhoto) body.photo = state.editPhoto;
    if (state.editRemovePhoto) body.remove_photo = true;
    saveCard(body, 'Saved');
  });
}

// ───────────────────────────── camera ─────────────────────────────

const Camera = {
  stream: null,
  track: null,
  async start(video) {
    if (this.stream && this.track && this.track.readyState === 'live') {
      if (video.srcObject !== this.stream) video.srcObject = this.stream;
      await video.play().catch(() => {});
      return;
    }
    if (!window.isSecureContext) throw new Error('The camera only works when the library is opened over https://. Check the address starts with https.');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can\'t use the camera.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        throw new Error('Camera permission was refused. Allow the camera for this site in the browser\'s site settings. In Fully Kiosk Browser, also turn on Enable Webcam Access under Web Content Settings.');
      }
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') throw new Error('No camera was found on this device.');
      throw new Error('The camera couldn\'t start: ' + e.message);
    }
    this.track = this.stream.getVideoTracks()[0];
    try { await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* not supported */ }
    video.srcObject = this.stream;
    await video.play().catch(() => {});
  },
  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    $('#video').srcObject = null;
  },
  torchSupported() {
    try { return !!this.track?.getCapabilities?.().torch; } catch { return false; }
  },
  async setTorch(on) {
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
  },
};

const Scanner = {
  engine: null,       // 'native' (BarcodeDetector) or 'zxing'
  detector: null,
  reader: null,
  canvas: null,
  token: null,
  lastCode: null,
  lastAt: 0,

  async ready() {
    if (this.engine) return;
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => supported.includes(f));
        if (want.includes('ean_13')) {
          this.detector = new window.BarcodeDetector({ formats: want });
          this.engine = 'native';
          return;
        }
      } catch { /* fall through to ZXing */ }
    }
    await loadScript(LIBS.zxing);
    this.reader = new window.ZXingBrowser.BrowserMultiFormatOneDReader();
    this.canvas = document.createElement('canvas');
    this.engine = 'zxing';
  },

  async start(video, onCode) {
    await this.ready();
    const token = {};
    this.token = token;
    const tick = async () => {
      if (this.token !== token) return;
      let code = null;
      try { if (video.readyState >= 2 && video.videoWidth) code = await this.read(video); } catch { /* keep trying */ }
      if (this.token !== token) return;
      if (code && this.accept(code)) {
        this.token = null;
        onCode(code);
        return;
      }
      setTimeout(tick, this.engine === 'native' ? 120 : 160);
    };
    tick();
  },

  stop() { this.token = null; },

  async read(video) {
    if (this.engine === 'native') {
      const found = await this.detector.detect(video);
      const hit = found.find((f) => /^\d{8,13}$/.test(f.rawValue));
      return hit ? hit.rawValue : null;
    }
    // ZXing: decode the middle band of the frame, scaled down for speed.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sw = Math.round(vw * 0.85);
    const sh = Math.round(vh * 0.55);
    const scale = Math.min(1, 1200 / sw);
    const c = this.canvas;
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, c.width, c.height);
    try {
      const text = this.reader.decodeFromCanvas(c).getText();
      return /^\d{8,13}$/.test(text) ? text : null;
    } catch { return null; }
  },

  /** Valid check digit = accept at once. Anything else must read the same twice in a row. */
  accept(code) {
    if (checksumOk(code)) return true;
    const now = Date.now();
    const ok = code === this.lastCode && now - this.lastAt < 1500;
    this.lastCode = code;
    this.lastAt = now;
    return ok;
  },
};

// ───────────────────────────── images & OCR ─────────────────────────────

function scaledCanvas(src, sx, sy, sw, sh, maxSide, minSide = 0) {
  let scale = Math.min(1, maxSide / Math.max(sw, sh));
  if (minSide && Math.max(sw, sh) * scale < minSide) scale = minSide / Math.max(sw, sh);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/** The part of the camera frame inside the cover-shaped guide, as a canvas. */
function cropToGuide(video, maxSide) {
  const vf = $('#viewfinder').getBoundingClientRect();
  const r = $('#reticle').getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const s = Math.max(vf.width / vw, vf.height / vh);          // object-fit: cover
  const dx = (vf.width - vw * s) / 2;
  const dy = (vf.height - vh * s) / 2;
  let x = (r.left - vf.left - dx) / s;
  let y = (r.top - vf.top - dy) / s;
  let w = r.width / s;
  let h = r.height / s;
  // A little margin, kept inside the frame.
  const mx = w * 0.04;
  const my = h * 0.04;
  x = Math.max(0, x - mx); y = Math.max(0, y - my);
  w = Math.min(vw - x, w + 2 * mx); h = Math.min(vh - y, h + 2 * my);
  if (!(w > 20 && h > 20)) return scaledCanvas(video, 0, 0, vw, vh, maxSide);
  return scaledCanvas(video, x, y, w, h, maxSide, 1400);
}

function fileToCanvas(file, maxSide) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(scaledCanvas(img, 0, 0, img.naturalWidth, img.naturalHeight, maxSide));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn\'t a picture this browser can open.')); };
    img.src = url;
  });
}

const OCR = {
  worker: null,
  onProgress: null,
  async getWorker() {
    if (!window.Tesseract) await loadScript(LIBS.tesseract);
    if (!this.worker) {
      this.worker = await window.Tesseract.createWorker('eng', 1, {
        logger: (m) => { if (this.onProgress) this.onProgress(m); },
      });
      // Sparse-text mode: covers are scattered words in mixed sizes, not a page of text.
      // (Tesseract.js otherwise assumes one uniform block and can skip the big title lettering.)
      await this.worker.setParameters({ tessedit_pageseg_mode: '11' });
    }
    return this.worker;
  },
  /**
   * Read the text on a cover. Returns candidate lines, biggest lettering first —
   * on a DVD cover the title is nearly always the largest text.
   */
  async read(canvas, onProgress) {
    this.onProgress = onProgress;
    const worker = await this.getWorker();
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    this.onProgress = null;
    const lines = [];
    for (const b of data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) {
          lines.push({ text: l.text, conf: l.confidence, y: l.bbox.y0, h: l.bbox.y1 - l.bbox.y0 });
        }
      }
    }
    if (!lines.length && data.text) {
      data.text.split('\n').forEach((t, i) => lines.push({ text: t, conf: 60, y: i, h: 1 }));
    }
    const noise = /^(dvd|blu[- ]?ray|4k|ultra hd|widescreen|full ?screen|region \d|pal|ntsc|g|pg|m|ma ?15\+?|r ?18\+?|ctc|special edition|collector'?s edition|digital|bonus features?)$/i;
    const seen = new Set();
    const out = [];
    for (const l of lines) {
      const text = l.text.replace(/[^\p{L}\p{N}&'’:!?,.\- ]/gu, ' ').replace(/\s+/g, ' ').trim()
        .replace(/^(?:dvd|blu-?ray|4k)\s+|\s+(?:dvd|blu-?ray|4k)$/gi, '');
      const letters = (text.match(/\p{L}/gu) || []).length;
      if (letters < 2 || letters / text.length < 0.6 || l.conf < 35 || noise.test(text)) continue;
      const key = norm(text);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, y: l.y, h: l.h });
    }
    return out.sort((a, b) => b.h - a.h).slice(0, 10);
  },
};

// ───────────────────────────── adding discs ─────────────────────────────

const adder = {
  mode: 'barcode',        // barcode | cover | type
  stage: 'capture',       // capture | busy | results | confirm | manual
  rematch: null,          // item whose match is being changed
  p: {},                  // everything about the disc being added
};

/**
 * Start a new disc. A scanned barcode is carried over only when it wasn't recognised —
 * that's when you switch to a photo or typing to find the title for the same disc.
 */
function freshPending(keepBarcode) {
  const p = adder.p;
  const unresolved = p.barcode && !p.lookup?.in_library?.length && p.lookup?.product?.status !== 'found';
  return keepBarcode && unresolved ? { barcode: p.barcode, lookup: p.lookup } : {};
}

function openAdder({ rematch = null, swap = false } = {}) {
  adder.rematch = rematch;
  adder.p = {};
  $('#adder-title').textContent = rematch ? `Change match for ${rematch.title}` : 'Add discs';
  $('.modes').hidden = !!rematch;
  $('.adder-shelf').querySelectorAll('.field, .check').forEach((el) => { el.hidden = !!rematch; });
  $('#a-shelf').value = store.get('shelf', '');
  $('#a-keep').checked = store.get('keepAdding', true);
  $('#adder').hidden = false;
  if (!swap) Nav.push();
  if (rematch) {
    adder.p = { query: rematch.title, year: rematch.year || '', type: rematch.media_type === 'tv' ? 'tv' : 'multi' };
    setMode('type', { keepPending: true });
    runSearch();
  } else {
    setMode(store.get('mode', 'barcode'));
  }
}

function closeAdder({ fromHistory = false, swap = false } = {}) {
  if ($('#adder').hidden) return;
  Scanner.stop();
  Camera.stop();
  $('#adder').hidden = true;
  adder.rematch = null;
  adder.p = {};
  if (!fromHistory && !swap) Nav.pop();
}

async function setMode(mode, { keepBarcode = false, keepPending = false } = {}) {
  Scanner.stop();
  adder.mode = mode;
  if (!adder.rematch) store.set('mode', mode);
  if (!keepPending) adder.p = freshPending(keepBarcode);
  $$('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#adder-body').classList.toggle('no-camera', mode === 'type');
  $('#reticle').className = 'reticle ' + (mode === 'cover' ? 'is-cover' : 'is-barcode');
  $('#vf-shutter').hidden = mode !== 'cover';
  $('#still').hidden = true;
  $('#reticle').hidden = false;
  $('#vf-msg').hidden = true;
  adder.stage = mode === 'type' ? 'results' : 'capture';
  renderPanel();
  if (mode === 'type') {
    Camera.stop();
    setTimeout(() => $('#s-q')?.focus(), 50);
    return;
  }
  await startCamera();
}

async function startCamera() {
  const msg = $('#vf-msg');
  try {
    await Camera.start($('#video'));
    $('#btn-torch').hidden = !Camera.torchSupported();
    msg.hidden = true;
    if (adder.mode === 'barcode' && adder.stage === 'capture') {
      Scanner.start($('#video'), onBarcode).catch((e) => showVfMessage(e.message));
    }
  } catch (e) {
    showVfMessage(e.message);
  }
}

function showVfMessage(text) {
  const msg = $('#vf-msg');
  msg.textContent = text;
  msg.hidden = false;
}

function flashGuide() {
  const r = $('#reticle');
  r.classList.add('is-flash');
  setTimeout(() => r.classList.remove('is-flash'), 600);
}

function busy(message, withProgress = false) {
  adder.stage = 'busy';
  $('#panel').innerHTML = `<p><span class="spinner"></span>${esc(message)}</p>
    ${withProgress ? '<div class="progress"><div id="progress-bar"></div></div><p class="lead" id="progress-text"></p>' : ''}`;
}

// ── barcode ──

async function onBarcode(code) {
  beep();
  flashGuide();
  await lookupBarcode(code);
}

async function lookupBarcode(code) {
  adder.p = { barcode: code };
  busy(`Looking up barcode ${code}…`);
  try {
    adder.p.lookup = await api('barcode', { params: { code } });
  } catch (e) {
    adder.p.lookupError = e.message;
  }
  const lk = adder.p.lookup;
  if (lk?.guess) {
    adder.p.query = lk.guess.title;
    adder.p.year = lk.guess.year || '';
    adder.p.type = lk.guess.season ? 'tv' : 'multi';
    adder.p.results = lk.results;
  }
  adder.stage = 'results';
  renderPanel();
}

// ── cover photo ──

async function snapCover() {
  const video = $('#video');
  if (!video.videoWidth) return toast('The camera isn\'t ready yet.', true);
  flashGuide();
  await handleCoverImage(cropToGuide(video, 1800));
}

async function handleCoverImage(canvas) {
  const keep = freshPending(true);
  const still = $('#still');
  still.src = canvas.toDataURL('image/jpeg', 0.85);
  still.hidden = false;
  $('#reticle').hidden = true;
  $('#vf-shutter').hidden = true;
  adder.p = { ...keep, photo: scaledCanvas(canvas, 0, 0, canvas.width, canvas.height, 900).toDataURL('image/jpeg', 0.82), fromCover: true };
  busy('Reading the cover…', true);
  try {
    const lines = await OCR.read(canvas, (m) => {
      const bar = $('#progress-bar');
      if (!bar) return;
      const loading = /load|initializ/i.test(m.status || '');
      bar.style.width = Math.round((m.progress || 0) * 100) + '%';
      $('#progress-text').textContent = loading ? 'Getting the text reader ready (first time only)…' : 'Finding the words…';
    });
    adder.p.chips = lines.map((l, i) => ({ ...l, on: false, i }));
    // Start with the biggest line; add the next if the first is very short.
    if (adder.p.chips[0]) adder.p.chips[0].on = true;
    if (adder.p.chips[0] && adder.p.chips[0].text.length < 5 && adder.p.chips[1]) adder.p.chips[1].on = true;
    adder.p.query = chipQuery();
  } catch (e) {
    adder.p.ocrError = e.message;
    adder.p.chips = [];
  }
  adder.stage = 'results';
  renderPanel();
  if (adder.p.query && state.status.tmdb) runSearch();
}

function chipQuery() {
  return (adder.p.chips || []).filter((c) => c.on).sort((a, b) => a.y - b.y).map((c) => c.text).join(' ');
}

function retakeCover() {
  $('#still').hidden = true;
  $('#reticle').hidden = false;
  $('#vf-shutter').hidden = false;
  adder.p = freshPending(true);
  adder.stage = 'capture';
  renderPanel();
  startCamera();
}

// ── searching ──

let searchSeq = 0;
async function runSearch() {
  const q = (adder.p.query || '').trim();
  if (!q || !state.status.tmdb) return;
  const seq = ++searchSeq;
  adder.p.searching = true;
  adder.p.searchError = null;
  renderHitsOnly();
  try {
    const params = { q, type: adder.p.type || 'multi' };
    if (adder.p.year) params.year = adder.p.year;
    const r = await api('search', { params });
    if (seq !== searchSeq) return;
    adder.p.results = r.results;
  } catch (e) {
    if (seq !== searchSeq) return;
    adder.p.searchError = e.message;
    adder.p.results = [];
  }
  adder.p.searching = false;
  renderHitsOnly();
}

// ── panel rendering ──

function searchFormHtml() {
  const p = adder.p;
  const t = p.type || 'multi';
  return `<form id="s-form" class="row" autocomplete="off">
    <label class="field"><span>Title</span><input id="s-q" name="q" type="search" value="${esc(p.query || '')}" placeholder="e.g. The Castle" enterkeyhint="search"></label>
    <label class="field narrow"><span>Year</span><input name="year" inputmode="numeric" value="${esc(p.year || '')}" maxlength="4"></label>
    <label class="field mid"><span>Kind</span><select name="type">
      <option value="multi" ${t === 'multi' ? 'selected' : ''}>Films and TV</option>
      <option value="movie" ${t === 'movie' ? 'selected' : ''}>Film</option>
      <option value="tv" ${t === 'tv' ? 'selected' : ''}>TV series</option>
    </select></label>
    <button class="btn btn-brass" type="submit">Search</button>
  </form>`;
}

function hitHtml(h, idx) {
  const img = h.poster_path ? `<img src="${TMDB_IMG}w154${esc(h.poster_path)}" alt="" loading="lazy">` : '<div class="noimg"></div>';
  const owned = h.owned?.length
    ? `<div class="owned">Already in the library: ${h.owned.map((o) => esc([o.format, seasonLabel(o.season), o.location].filter(Boolean).join(', '))).join('; ')}</div>`
    : '';
  return `<button class="hit" type="button" data-hit="${idx}">${img}
    <div><b>${esc(h.title)}</b>
      <div class="meta">${esc([h.year, typeLabel(h.media_type)].filter(Boolean).join(', '))}${h.original_title && h.original_title !== h.title ? ` — ${esc(h.original_title)}` : ''}</div>
      ${h.overview ? `<div class="ov">${esc(h.overview)}</div>` : ''}${owned}
    </div></button>`;
}

function hitsHtml() {
  const p = adder.p;
  if (!state.status.tmdb) return '';
  if (p.searching) return '<p><span class="spinner"></span>Searching TMDB…</p>';
  if (p.searchError) return `<div class="notice bad">${esc(p.searchError)}</div>`;
  if (!p.results) return '';
  if (!p.results.length) {
    return `<div class="notice">No matches for “${esc(p.query || '')}”. Try fewer words, check the spelling, or add it by hand.</div>`;
  }
  return `<h3>Pick the right one</h3><div class="hits">${p.results.map(hitHtml).join('')}</div>`;
}

function renderHitsOnly() {
  const box = $('#hits-box');
  if (box) box.innerHTML = hitsHtml();
  else renderPanel();
}

function barcodeNoticeHtml() {
  const p = adder.p;
  if (!p.barcode) return '';
  const lk = p.lookup;
  if (!lk) {
    if (p.lookupError) return `<div class="notice bad">Barcode ${esc(p.barcode)}: ${esc(p.lookupError)}</div>`;
    return `<div class="notice">Barcode ${esc(p.barcode)} will be saved with this disc. <button class="btn btn-quiet" type="button" data-act="forget-barcode">Don't save it</button></div>`;
  }
  const pr = lk.product || {};
  if (pr.status === 'found') {
    return `<div class="notice">Barcode ${esc(lk.code)} is <span class="product">${esc(pr.title)}</span></div>`;
  }
  const why = pr.message || 'That barcode isn\'t in the free barcode database.';
  return `<div class="notice warn">Barcode ${esc(lk.code)} wasn't recognised. ${esc(why)}
    It will still be saved with the disc once you find the title.</div>`;
}

function renderPanel() {
  const panel = $('#panel');
  const p = adder.p;
  const tmdbOff = !state.status.tmdb
    ? '<div class="notice warn">Online lookups are off until a TMDB key is added to config.php. You can still add discs by hand.</div>'
    : '';

  if (adder.stage === 'capture' && adder.mode === 'barcode') {
    panel.innerHTML = `${tmdbOff}
      <h3>Scan a barcode</h3>
      <p class="lead">Hold the back of the case up to the camera with the barcode inside the frame. It beeps when it reads one.</p>
      <form id="code-form" class="row">
        <label class="field"><span>Or type the barcode numbers</span><input name="code" inputmode="numeric" autocomplete="off" placeholder="e.g. 9321337066789"></label>
        <button class="btn" type="submit">Look up</button>
      </form>`;
    return;
  }

  if (adder.stage === 'capture' && adder.mode === 'cover') {
    panel.innerHTML = `${tmdbOff}${barcodeNoticeHtml()}
      <h3>Photograph the cover</h3>
      <p class="lead">Fill the frame with the front cover and take the photo. The title is read from the picture, and the photo can be kept with the disc.</p>`;
    return;
  }

  if (adder.stage === 'results') {
    const lk = p.lookup;
    if (lk?.in_library?.length && !p.anotherCopy && !adder.rematch && adder.mode === 'barcode') {
      panel.innerHTML = `${barcodeNoticeHtml()}
        <h3>Already on your shelves</h3>
        <div class="hits">${lk.in_library.map((it) => `<button class="hit" type="button" data-open="${it.id}">
            ${coverSrc(it, 'w154') ? `<img src="${esc(coverSrc(it, 'w154'))}" alt="">` : '<div class="noimg"></div>'}
            <div><b>${esc(it.title)}</b><div class="meta">${esc([it.year, it.format, seasonLabel(it.season), it.location].filter(Boolean).join(', '))}</div>
            ${it.loaned_to ? `<div class="owned">On loan to ${esc(it.loaned_to)}</div>` : ''}</div></button>`).join('')}</div>
        <div class="panel-actions">
          <button class="btn btn-brass grow" type="button" data-act="next">Scan the next one</button>
          <button class="btn" type="button" data-act="another-copy">Add another copy</button>
        </div>`;
      return;
    }

    const chips = p.chips;
    const chipsHtml = chips
      ? (chips.length
        ? `<p class="lead">Words found on the cover. Tap the ones that make up the title.</p>
           <div class="chips">${chips.map((c, i) => `<button class="chip" type="button" data-chip="${i}" aria-pressed="${c.on}">${esc(c.text)}</button>`).join('')}</div>`
        : `<div class="notice warn">${esc(p.ocrError || 'No readable title was found on that photo.')} Type the title below, or retake the photo closer and with less glare.</div>`)
      : '';
    const needsTitle = p.barcode && (!lk || lk.product?.status !== 'found') && adder.mode === 'barcode';
    panel.innerHTML = `${tmdbOff}${barcodeNoticeHtml()}${chipsHtml}
      ${needsTitle ? `<div class="panel-actions" style="margin-top:0;margin-bottom:14px">
          <button class="btn" type="button" data-act="to-cover">Photograph the cover instead</button></div>` : ''}
      ${searchFormHtml()}
      <div id="hits-box">${hitsHtml()}</div>
      <div class="panel-actions">
        <button class="btn" type="button" data-act="manual">${adder.rematch ? 'Enter the details by hand' : 'Not listed? Add it by hand'}</button>
        ${adder.mode === 'barcode' && !adder.rematch ? '<button class="btn" type="button" data-act="next">Scan a different barcode</button>' : ''}
        ${adder.mode === 'cover' ? '<button class="btn" type="button" data-act="retake">Retake photo</button>' : ''}
      </div>`;
    return;
  }

  if (adder.stage === 'confirm') {
    const h = p.selected;
    const img = h.poster_path ? `<img src="${TMDB_IMG}w185${esc(h.poster_path)}" alt="">` : '<div class="noimg"></div>';
    const summary = `<div class="chosen">${img}<div><b>${esc(h.title)}</b>
      <div class="lead">${esc([h.year, typeLabel(h.media_type)].filter(Boolean).join(', '))}</div>
      ${h.overview ? `<div class="lead">${esc(h.overview)}</div>` : ''}</div></div>`;

    if (adder.rematch) {
      panel.innerHTML = `${summary}
        <p class="lead">Swap the details of “${esc(adder.rematch.title)}” for this match. Its shelf, format, notes and loan stay as they are.</p>
        <div class="panel-actions">
          <button class="btn btn-brass grow" type="button" data-act="save">Use this match</button>
          <button class="btn" type="button" data-act="back">Back to the list</button>
        </div>`;
      return;
    }
    const owned = h.owned?.length
      ? `<div class="notice warn">You already have this: ${h.owned.map((o) => esc([o.format, seasonLabel(o.season), o.location].filter(Boolean).join(', '))).join('; ')}. Add it again only if it's a second copy or another edition.</div>`
      : '';
    panel.innerHTML = `${summary}${owned}${confirmFieldsHtml(h.media_type)}
      <div class="panel-actions">
        <button class="btn btn-brass grow" type="button" data-act="save">Add to library</button>
        <button class="btn" type="button" data-act="back">Back to the list</button>
      </div>`;
    return;
  }

  if (adder.stage === 'manual') {
    const r = adder.rematch;
    const title = r ? r.title : (p.query || '');
    const mt = r ? r.media_type : (p.type === 'tv' ? 'tv' : 'movie');
    panel.innerHTML = `
      <h3>${r ? 'Enter the details by hand' : 'Add by hand'}</h3>
      <p class="lead">${r ? 'These replace the TMDB details. Shelf, format, notes and loan stay as they are.' : 'For discs TMDB doesn\'t know: home videos, concerts, fitness, compilations.'}</p>
      <div class="confirm" id="manual-fields">
        <label class="field wide"><span>Title</span><input name="title" value="${esc(title)}" autocomplete="off"></label>
        <label class="field"><span>Year</span><input name="year" inputmode="numeric" value="${esc(r ? r.year || '' : p.year || '')}"></label>
        <label class="field"><span>Kind</span><select name="media_type">
          ${['movie', 'tv', 'other'].map((t) => `<option value="${t}" ${mt === t ? 'selected' : ''}>${typeLabel(t)}</option>`).join('')}</select></label>
        <label class="field"><span>Genres</span><input name="genres" value="${esc(r?.genres || '')}"></label>
        <label class="field"><span>Director or creator</span><input name="directors" value="${esc(r?.directors || '')}"></label>
        <label class="field wide"><span>Starring</span><input name="cast_list" value="${esc(r?.cast_list || '')}"></label>
        <label class="field"><span>Running time (minutes)</span><input name="runtime" inputmode="numeric" value="${esc(r?.runtime || '')}"></label>
        <label class="field"><span>Classification</span><input name="certification" value="${esc(r?.certification || '')}" placeholder="e.g. M"></label>
        <label class="field wide"><span>Summary</span><textarea name="overview">${esc(r?.overview || '')}</textarea></label>
      </div>
      ${r ? '' : `<h3 style="margin-top:18px">Your copy</h3>${confirmFieldsHtml(mt)}`}
      <div class="panel-actions">
        <button class="btn btn-brass grow" type="button" data-act="save-manual">${r ? 'Save these details' : 'Add to library'}</button>
        <button class="btn" type="button" data-act="back">Back</button>
      </div>`;
  }
}

function confirmFieldsHtml(mediaType) {
  const p = adder.p;
  const guess = p.lookup?.guess || {};
  const format = guess.format || store.get('format', 'DVD');
  return `<div class="confirm" id="confirm-fields">
    <label class="field"><span>Shelf</span><input name="location" list="shelf-list" value="${esc($('#a-shelf').value.trim())}" autocomplete="off"></label>
    <label class="field"><span>Format</span><input name="format" list="format-list" value="${esc(format)}" autocomplete="off"></label>
    ${mediaType === 'tv' || guess.season ? `<label class="field"><span>Season or volume</span><input name="season" value="${esc(guess.season || '')}" placeholder="e.g. 2, or Complete"></label>` : ''}
    <label class="field"><span>Number of discs</span><input name="discs" inputmode="numeric" placeholder="1"></label>
    <label class="field wide"><span>Notes</span><input name="notes" placeholder="Edition, condition, extras…" autocomplete="off"></label>
    <label class="field"><span>Barcode</span><input name="barcode" inputmode="numeric" value="${esc(p.barcode || '')}"></label>
    ${p.photo ? `<label class="check wide"><input type="checkbox" name="keep_photo" checked> Keep my photo of this cover</label>` : ''}
  </div>`;
}

function readFields(containerId) {
  const box = $('#' + containerId);
  const out = {};
  if (!box) return out;
  for (const el of $$('input, select, textarea', box)) {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return out;
}

async function saveFromAdder(manual) {
  const p = adder.p;
  const btn = $('#panel [data-act="save"], #panel [data-act="save-manual"]');
  if (btn) btn.disabled = true;
  try {
    let body;
    if (adder.rematch) {
      body = { id: adder.rematch.id };
      if (manual) {
        const m = readFields('manual-fields');
        if (!m.title) throw new Error('A title is needed.');
        body.manual = m;
      } else {
        body.tmdb = { media_type: p.selected.media_type, id: p.selected.tmdb_id };
      }
    } else {
      const f = readFields('confirm-fields');
      body = {
        fields: { location: f.location, format: f.format || 'DVD', season: f.season || '', discs: f.discs, notes: f.notes, barcode: f.barcode },
      };
      if (manual) {
        const m = readFields('manual-fields');
        if (!m.title) throw new Error('A title is needed.');
        body.manual = m;
      } else {
        body.tmdb = { media_type: p.selected.media_type, id: p.selected.tmdb_id };
      }
      if (p.photo && f.keep_photo) body.photo = p.photo;
      if (f.location) { store.set('shelf', f.location); $('#a-shelf').value = f.location; }
      if (f.format) store.set('format', f.format);
    }
    const r = await api('save', { body });
    upsertItem(r.item);
    if (adder.rematch) {
      const id = r.item.id;
      closeAdder({ swap: true });
      openDetail(id, { swap: true });
      toast('Match changed');
      return;
    }
    toast(`Added ${r.item.title}${r.item.location ? ` to ${r.item.location}` : ''}`);
    if ($('#a-keep').checked) {
      await setMode(adder.mode);
    } else {
      closeAdder();
    }
  } catch (e) {
    toast(e.message, true);
    if (btn) btn.disabled = false;
  }
}

function wireAdder() {
  $$('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode, { keepBarcode: true })));
  $('#adder-close').addEventListener('click', () => closeAdder());
  $('#a-shelf').addEventListener('change', (e) => store.set('shelf', e.target.value.trim()));
  $('#a-keep').addEventListener('change', (e) => store.set('keepAdding', e.target.checked));
  $('#btn-snap').addEventListener('click', snapCover);
  $('#file-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { await handleCoverImage(await fileToCanvas(file, 1800)); } catch (err) { toast(err.message, true); }
  });
  $('#btn-torch').addEventListener('click', async (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    try {
      await Camera.setTorch(on);
      e.currentTarget.setAttribute('aria-pressed', String(on));
    } catch { toast('The torch can\'t be switched on from the browser on this device.', true); }
  });

  const panel = $('#panel');
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'code-form') {
      const code = e.target.code.value.replace(/\D/g, '');
      if (code.length < 8) return toast('A barcode has 8, 12 or 13 digits.', true);
      Scanner.stop();
      lookupBarcode(code);
    }
    if (e.target.id === 's-form') {
      const fd = new FormData(e.target);
      adder.p.query = String(fd.get('q') || '').trim();
      adder.p.year = String(fd.get('year') || '').replace(/\D/g, '');
      adder.p.type = String(fd.get('type') || 'multi');
      if (!adder.p.query) return;
      $('#s-q').blur();
      runSearch();
    }
  });

  panel.addEventListener('click', (e) => {
    const hit = e.target.closest('[data-hit]');
    if (hit) {
      adder.p.selected = adder.p.results[Number(hit.dataset.hit)];
      adder.stage = 'confirm';
      renderPanel();
      panel.scrollTop = 0;
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      closeAdder({ swap: true });
      openDetail(Number(open.dataset.open), { swap: true });
      return;
    }
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const c = adder.p.chips[Number(chip.dataset.chip)];
      c.on = !c.on;
      chip.setAttribute('aria-pressed', String(c.on));
      adder.p.query = chipQuery();
      $('#s-q').value = adder.p.query;
      runSearch();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'next') setMode(adder.mode);
    if (act === 'retake') retakeCover();
    if (act === 'to-cover') setMode('cover', { keepBarcode: true });
    if (act === 'another-copy') { adder.p.anotherCopy = true; renderPanel(); }
    if (act === 'forget-barcode') { delete adder.p.barcode; delete adder.p.lookup; renderPanel(); }
    if (act === 'manual') { adder.stage = 'manual'; renderPanel(); panel.scrollTop = 0; }
    if (act === 'back') { adder.stage = 'results'; renderPanel(); }
    if (act === 'save') saveFromAdder(false);
    if (act === 'save-manual') saveFromAdder(true);
  });
}

// ───────────────────────────── menu, sign-in, keys ─────────────────────────────

function wireMisc() {
  const menuBtn = $('#btn-menu');
  const menu = $('#menu-list');
  const setMenu = (open) => { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); };
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setMenu(false); });
  menu.addEventListener('click', () => setMenu(false));

  $('#menu-reload').addEventListener('click', loadLibrary);
  $('#menu-signout').addEventListener('click', async () => {
    const yes = await ask({ title: 'Sign out this tablet?', message: 'You will need the password to open the library again.', ok: 'Sign out' });
    if (!yes) return;
    try { await api('logout', { body: {} }); } catch { /* signing out anyway */ }
    showLogin();
  });
  $('#menu-about').addEventListener('click', () => ask({
    title: 'About DVD Library',
    message: `Version ${state.status.version}. Film and TV details and posters come from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Barcode titles come from UPCitemdb's free lookup.`,
    ok: 'Close',
    cancel: '',
  }));

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.textContent = '';
    try {
      await api('login', { body: { password: $('#login-pw').value } });
      $('#login-pw').value = '';
      const st = await api('status');
      state.status = st;
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modal').hidden) return closeModal(null);
    if (!$('#adder').hidden) return closeAdder();
    if (!$('#detail').hidden) return closeDetail();
  });

  // Give the camera back when the tablet sleeps or the app is hidden.
  document.addEventListener('visibilitychange', () => {
    if ($('#adder').hidden || adder.mode === 'type') return;
    if (document.hidden) {
      Scanner.stop();
      Camera.stop();
    } else if (adder.stage === 'capture') {
      startCamera();
    }
  });
}

// ───────────────────────────── start ─────────────────────────────

async function boot() {
  wireLibrary();
  wireCard();
  wireAdder();
  wireMisc();
  let st;
  try {
    st = await api('status');
  } catch (e) {
    showSetup([e.message]);
    return;
  }
  if (!st.configured) return showSetup(st.problems || []);
  state.status = st;
  if (!st.authed) return showLogin();
  await enterApp();
}

boot();
