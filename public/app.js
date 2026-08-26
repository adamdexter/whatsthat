'use strict';

// ---------- State ----------
const S = {
  mock: false,
  wa: { status: 'starting' },
  google: { configured: false, connected: false },
  headers: [],
  contacts: [],
  selected: new Set(),
  filters: {}, // header -> Set of selected values (lowercased; '__blank__' for empty cells)
  savedFilters: {}, // from the persisted draft, applied when contacts load
  previews: new Map(), // contact id -> { text, unknown, empty }
  previewId: null,
  contactsCache: null, // last loaded contact list, persisted for restore on restart
  running: false,
  progressCount: 0,
  totalToSend: 0,
  reportFilter: { sent: true, failed: true, cancelled: true }, // which statuses the run list shows
  history: {}, // phone -> { at, text, reportFile, count } — last successful send (from reports)
  schedule: [],
  lastTab: 'contacts', // persisted via the draft; Setup is never remembered
};

const BLANK = '__blank__';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // A tab left open across an engine restart holds a stale token cookie;
    // one reload picks up the new one (guarded so a real 401 can't loop).
    if (!sessionStorage.getItem('wt-reloaded-401')) {
      sessionStorage.setItem('wt-reloaded-401', '1');
      location.reload();
    }
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// ---------- Header pills ----------
function renderPills() {
  const waPill = $('pill-wa');
  const map = {
    starting: ['Starting…', 'warn'],
    qr: ['Scan QR', 'warn'],
    authenticating: ['Authenticating…', 'warn'],
    ready: [`Connected ${S.wa.self ? esc(S.wa.self.number) : ''}`, 'ok'],
    disconnected: ['Disconnected', 'err'],
    error: ['Error', 'err'],
  };
  const br = S.wa.browser;
  const downloading = br && br.status === 'downloading' && S.wa.status !== 'ready';
  const [label, cls] = downloading ? [`Downloading browser ${Number(br.percent) || 0}%`, 'warn'] : map[S.wa.status] || [S.wa.status, 'warn'];
  waPill.textContent = `WhatsApp: ${label}`;
  waPill.className = `pill ${cls}`;

  const gPill = $('pill-google');
  const gState = S.google.connected ? ['Connected', 'ok'] : S.google.configured ? ['Not connected', 'warn'] : ['Not set up', 'warn'];
  gPill.textContent = `Google: ${gState[0]}`;
  gPill.className = `pill ${gState[1]}`;

  $('pill-mock').classList.toggle('hidden', !S.mock);
}

// ---------- Card 1: WhatsApp ----------
function renderWa() {
  const el = $('wa-body');
  const st = S.wa;
  const br = st.browser || {};
  if (br.status === 'downloading' && st.status !== 'ready') {
    const pct = Math.max(0, Math.min(100, Number(br.percent) || 0));
    el.innerHTML = `
      <div class="status-line"><span class="dot warn"></span> Downloading the browser WhatsApp Web runs in… <b>${pct}%</b>
        <span class="muted">(one-time, about 160 MB)</span></div>
      <div class="progress-track"><div class="progress-bar" style="width:${pct}%"></div></div>`;
  } else if (st.status === 'qr') {
    el.innerHTML = `
      <div class="qr-wrap">
        <img src="${st.qrDataUrl}" alt="WhatsApp QR code" width="280" height="280" />
        <div class="qr-steps">
          <b>Link this app to your WhatsApp:</b>
          <ol>
            <li>Open WhatsApp on your phone</li>
            <li>Tap <b>Settings → Linked Devices → Link a Device</b></li>
            <li>Scan this QR code</li>
          </ol>
          <p class="muted">One-time step — the session is saved locally for future runs.</p>
        </div>
      </div>`;
  } else if (st.status === 'ready') {
    el.innerHTML = `
      <div class="status-line">
        <span class="dot ok"></span>
        Connected as <b>${esc(st.self?.number || '')}</b>${st.self?.name ? ` (${esc(st.self.name)})` : ''}
        — messages will be sent from this number.
      </div>`;
  } else if (st.status === 'starting' || st.status === 'authenticating') {
    el.innerHTML = `<div class="status-line"><span class="dot warn"></span> ${
      st.status === 'starting' ? 'Starting WhatsApp client… (first launch can take ~30s)' : 'Authenticating…'
    }</div>`;
  } else {
    el.innerHTML = `<div class="status-line"><span class="dot err"></span> ${esc(st.error || st.status)}</div>`;
  }
  renderRunButton();
}

// ---------- Card 2: Google ----------
function renderGoogle() {
  const el = $('google-body');
  if (S.google.connected) {
    el.innerHTML = `
      <div class="status-line">
        <span class="dot ok"></span> Google Sheets connected.
        <button id="btn-g-disconnect">Disconnect</button>
      </div>`;
    $('btn-g-disconnect').onclick = async () => {
      S.google = await api('/api/google/disconnect', { method: 'POST' });
      renderGoogle();
      renderPills();
    };
    $('google-help').classList.add('hidden');
  } else if (S.google.configured) {
    el.innerHTML = `
      <div class="status-line">
        <span class="dot warn"></span> Credentials saved — now authorize access:
        <button id="btn-g-connect" class="primary">Connect Google</button>
        <button id="btn-g-reset">Change credentials</button>
      </div>`;
    $('btn-g-connect').onclick = async () => {
      try {
        const { url } = await api('/api/google/auth-url');
        window.open(url, '_blank'); // the app shell forwards this to the default browser
      } catch (err) {
        el.insertAdjacentHTML('beforeend', `<div class="error">${esc(err.message)}</div>`);
      }
    };
    $('btn-g-reset').onclick = () => {
      S.google.configured = false;
      renderGoogle();
    };
    $('google-help').classList.remove('hidden');
  } else {
    el.innerHTML = `
      <div class="row">
        <input type="text" id="g-client-id" placeholder="OAuth Client ID" style="flex:1;min-width:260px" />
        <input type="password" id="g-client-secret" placeholder="Client secret" style="min-width:180px" />
        <button id="btn-g-save" class="primary">Save</button>
      </div>
      <div id="g-error" class="error hidden"></div>`;
    $('btn-g-save').onclick = async () => {
      try {
        S.google = await api('/api/google/credentials', {
          method: 'POST',
          body: { clientId: $('g-client-id').value, clientSecret: $('g-client-secret').value },
        });
        renderGoogle();
        renderPills();
      } catch (err) {
        $('g-error').textContent = err.message;
        $('g-error').classList.remove('hidden');
      }
    };
    $('google-help').classList.remove('hidden');
  }
  renderContactSources();
}

// CSV-first: pasted contacts need no setup, so that source leads unless
// Google is connected (then the sheet is the natural one).
function renderContactSources() {
  const csv = $('src-csv');
  const sheet = $('src-sheet');
  if (!csv || !sheet) return;
  const connected = Boolean(S.google && S.google.connected);
  const fromSheet = S.contactsCache && S.contactsCache.source === 'sheet';
  if (S.contacts.length) {
    // A list is loaded: fold the pickers away (the summaries stay clickable)
    // so the table gets the height.
    csv.open = false;
    sheet.open = false;
  } else {
    csv.open = !connected || S.contactsCache?.source === 'csv';
    sheet.open = connected || fromSheet;
  }
  const btn = $('btn-load-sheet');
  btn.disabled = !connected;
  btn.title = connected ? '' : 'Connect Google in Setup (gear) first';
}

function renderDataCard() {
  if (S.paths && S.paths.dataDir) $('data-dir-path').textContent = S.paths.dataDir;
}

// ---------- Card 3: Contacts ----------
// opts.restore = { selectedIds, previewId, loadedAt } when repopulating from
// the saved draft after a restart: the exact selection wins over the
// filter-derived one, and a note says the list came from the last session.
function setContacts(data, opts = {}) {
  S.headers = data.headers || [];
  S.contacts = data.contacts || [];
  // Restore saved send rules for columns that exist in this sheet, then let
  // them shape the initial selection.
  S.filters = {};
  for (const [h, values] of Object.entries(S.savedFilters || {})) {
    if (S.headers.some((x) => x.trim().toLowerCase() === h.trim().toLowerCase()) && Array.isArray(values) && values.length) {
      S.filters[h] = new Set(values);
    }
  }
  const restore = opts.restore;
  if (restore && Array.isArray(restore.selectedIds)) {
    const valid = new Set(S.contacts.filter((c) => c.phone).map((c) => c.id));
    S.selected = new Set(restore.selectedIds.filter((id) => valid.has(id)));
  } else {
    applyFiltersToSelection();
  }
  S.previewId =
    (restore != null && S.contacts.some((c) => c.id === restore.previewId && c.phone) ? restore.previewId : null) ??
    S.contacts.find((c) => S.selected.has(c.id))?.id ??
    S.contacts.find((c) => c.phone)?.id ??
    null;

  if (restore) {
    S.contactsCache = data; // keep the original loadedAt/source
  } else if (S.contacts.length) {
    S.contactsCache = { headers: S.headers, contacts: S.contacts, source: opts.source || 'sheet', loadedAt: new Date().toISOString() };
  } else {
    S.contactsCache = null;
  }

  const note = $('contacts-note');
  if (restore && S.contacts.length) {
    const when = restore.loadedAt ? new Date(restore.loadedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'last session';
    note.textContent = `↩︎ Restored from your last session (loaded ${when}) — Load from Sheet to refresh.`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  const errEl = $('contacts-error');
  if (data.error) {
    errEl.textContent = data.error;
    errEl.classList.remove('hidden');
  } else {
    errEl.classList.add('hidden');
  }
  renderFilters();
  renderContacts();
  renderChips();
  refreshPreviews();
  renderContactSources(); // fold the pickers once a list is in
  if (!restore) saveDraft();
}

// ---------- Send rules (filters on categorical columns like rank/Status) ----------

// Columns with a small set of repeating values (e.g. rank, Status) are
// offered as send rules. Mostly-unique columns (names, emails) are not.
function categoricalColumns() {
  if (S.contacts.length < 2) return [];
  const cols = [];
  for (const h of S.headers) {
    if (h.toLowerCase() === 'phone') continue;
    const seen = new Map(); // lowercased -> display casing
    let blanks = 0;
    for (const c of S.contacts) {
      const v = String(c.fields[h] ?? '').trim();
      if (v === '') blanks++;
      else if (!seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
    }
    if (seen.size >= 1 && seen.size <= 8 && seen.size < S.contacts.length) {
      cols.push({ header: h, values: [...seen.values()].sort(), hasBlank: blanks > 0 });
    }
  }
  return cols;
}

function contactMatchesFilters(c) {
  for (const [h, sel] of Object.entries(S.filters)) {
    if (!sel || sel.size === 0) continue;
    const v = String(c.fields[h] ?? '').trim();
    if (!sel.has(v === '' ? BLANK : v.toLowerCase())) return false;
  }
  return true;
}

function applyFiltersToSelection() {
  S.selected = new Set(S.contacts.filter((c) => c.phone && contactMatchesFilters(c)).map((c) => c.id));
}

function renderFilters() {
  const el = $('contact-filters');
  const cols = categoricalColumns();
  if (!cols.length) {
    el.innerHTML = '';
    return;
  }
  const anyActive = Object.values(S.filters).some((s) => s && s.size);
  el.innerHTML = `
    <div class="filters-box">
      <span class="filters-title">Send rules</span>
      ${anyActive ? '<a href="#" class="filters-clear" id="filters-clear">clear all</a>' : ''}
      ${cols
        .map((col) => {
          const sel = S.filters[col.header] || new Set();
          const chip = (value, key) =>
            `<button type="button" class="filter-chip ${sel.has(key) ? 'active' : ''}" data-col="${esc(col.header)}" data-key="${esc(key)}">${esc(value)}</button>`;
          return `<div class="filter-group">
            <span class="filter-name">${esc(col.header)}</span>
            ${col.values.map((v) => chip(v, v.toLowerCase())).join('')}
            ${col.hasBlank ? chip('(blank)', BLANK) : ''}
          </div>`;
        })
        .join('')}
      <div class="filters-hint">Toggling a rule reselects matching contacts (with valid phones). No rules on a row = that column is ignored. You can still check/uncheck individual people below.</div>
    </div>`;

  el.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.onclick = () => {
      const col = chip.dataset.col;
      const key = chip.dataset.key;
      const sel = S.filters[col] || (S.filters[col] = new Set());
      if (sel.has(key)) sel.delete(key);
      else sel.add(key);
      if (sel.size === 0) delete S.filters[col];
      applyFiltersToSelection();
      renderFilters();
      renderContacts();
      renderPreviewWarnings();
      saveDraft();
    };
  });
  const clear = $('filters-clear');
  if (clear) {
    clear.onclick = (e) => {
      e.preventDefault();
      S.filters = {};
      applyFiltersToSelection();
      renderFilters();
      renderContacts();
      renderPreviewWarnings();
      saveDraft();
    };
  }
}

function renderContacts() {
  const wrap = $('contacts-table-wrap');
  if (!S.contacts.length) {
    wrap.innerHTML = '';
    renderRunButton();
    return;
  }
  const headers = S.headers;
  const rows = S.contacts
    .map((c) => {
      const checked = S.selected.has(c.id) ? 'checked' : '';
      const disabled = c.phone ? '' : 'disabled';
      const phoneCell = c.phone
        ? `<td>${esc(c.phone)}</td>`
        : `<td class="phone-bad" title="${esc(c.phoneError || '')}">✗ ${esc(c.phoneError || 'invalid')}</td>`;
      const cells = headers
        .filter((h) => h.toLowerCase() !== 'phone')
        .map((h) => `<td>${esc(c.fields[h] || '')}</td>`)
        .join('');
      return `<tr class="${c.phone ? '' : 'invalid'}">
        <td><input type="checkbox" data-id="${c.id}" ${checked} ${disabled} /></td>
        ${cells}${phoneCell}${lastSentCell(c)}
      </tr>`;
    })
    .join('');
  const validIds = S.contacts.filter((c) => c.phone).map((c) => c.id);
  const allSelected = validIds.length > 0 && validIds.every((id) => S.selected.has(id));
  wrap.innerHTML = `
    <div class="contacts-toolbar">
      <button type="button" id="btn-inverse">Inverse selection</button>
    </div>
    <table>
      <thead><tr>
        <th><input type="checkbox" id="check-all" ${allSelected ? 'checked' : ''} /></th>
        ${headers.filter((h) => h.toLowerCase() !== 'phone').map((h) => `<th>${esc(h)}</th>`).join('')}
        <th>Phone</th>
        <th title="Last message WhatsThat delivered to this number (from the send reports)">Last sent</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="count-line" id="count-line"></div>`;

  $('btn-inverse').onclick = () => {
    S.selected = new Set(validIds.filter((id) => !S.selected.has(id)));
    renderContacts();
    renderPreviewWarnings();
    saveDraft();
  };

  wrap.querySelectorAll('tbody input[type=checkbox]').forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) S.selected.add(id);
      else S.selected.delete(id);
      renderCountLine();
      renderRunButton();
      renderPreviewWarnings();
      saveDraft();
    };
  });
  $('check-all').onchange = (e) => {
    S.selected = new Set(e.target.checked ? S.contacts.filter((c) => c.phone).map((c) => c.id) : []);
    renderContacts();
    renderRunButton();
    renderPreviewWarnings();
    saveDraft();
  };
  renderCountLine();
  renderRunButton();
}

// "Last sent" = the most recent message WhatsThat delivered to this phone,
// per the send reports (local; works for CSV contacts too). Hover shows
// the whole message.
const shortDate = (iso) => {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
};
function lastSentCell(c) {
  const h = c.phone ? S.history[c.phone] : null;
  if (!h) return '<td class="last-sent"></td>';
  const text = String(h.text || '').replace(/\s+/g, ' ').trim();
  const preview = text.length > 44 ? `${text.slice(0, 44)}…` : text;
  const tip = `${h.at ? new Date(h.at).toLocaleString() : ''}${h.count > 1 ? ` · ${h.count} messages so far` : ''}\n\n${text}`;
  return `<td class="last-sent" title="${esc(tip)}"><span class="when">${h.at ? esc(shortDate(h.at)) : ''}</span>${esc(preview)}</td>`;
}

async function refreshHistory() {
  try {
    const { byPhone } = await api('/api/history');
    S.history = byPhone || {};
  } catch {
    /* keep what we had */
  }
  if (S.contacts.length) renderContacts();
}

function renderCountLine() {
  const line = $('count-line');
  if (!line) return;
  const invalid = S.contacts.filter((c) => !c.phone).length;
  line.innerHTML =
    `<b>${S.selected.size}</b> of ${S.contacts.length} contacts selected` +
    (invalid ? ` — <span class="st-failed">${invalid} with invalid phone numbers (excluded)</span>` : '');
  // Keep the header checkbox honest as individual rows are toggled.
  const checkAll = $('check-all');
  if (checkAll) {
    const validIds = S.contacts.filter((c) => c.phone).map((c) => c.id);
    checkAll.checked = validIds.length > 0 && validIds.every((id) => S.selected.has(id));
  }
}

// ---------- Card 4: Message ----------
function renderChips() {
  const el = $('var-chips');
  el.innerHTML = S.headers
    .filter((h) => h.toLowerCase() !== 'phone')
    .map((h) => `<button type="button" class="chip" data-var="${esc(h)}">{{${esc(h)}}}</button>`)
    .join('');
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.onclick = () => {
      const ta = $('template');
      const v = `{{${chip.dataset.var}}}`;
      const start = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, start) + v + ta.value.slice(ta.selectionEnd ?? start);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + v.length;
      onTemplateChanged();
    };
  });
}

// ---------- Variable autocomplete in the template box ----------
// Typing "{" (or "{{") pops a suggestion list of the sheet's columns,
// filtered as you type. Arrows navigate, Enter/Tab/click inserts, Esc closes.
const AC = { open: false, items: [], index: 0, matchStart: 0 };

function acDetect() {
  const ta = $('template');
  if (ta.selectionStart !== ta.selectionEnd) return null;
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = upto.match(/\{\{?([A-Za-z0-9 _.-]*)$/);
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const items = S.headers
    .filter((h) => h.toLowerCase() !== 'phone')
    .filter((h) => h.toLowerCase().startsWith(prefix));
  if (!items.length) return null;
  return { matchStart: ta.selectionStart - m[0].length, items };
}

// Pixel position of the caret inside the textarea, via a hidden mirror div.
function caretXY(ta) {
  const style = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of [
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing',
  ]) {
    div.style[p] = style[p];
  }
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.width = `${ta.clientWidth}px`;
  div.textContent = ta.value.slice(0, ta.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '​';
  div.appendChild(marker);
  ta.parentNode.appendChild(div);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45 || 20;
  const xy = { top: marker.offsetTop - ta.scrollTop + lineHeight + 4, left: marker.offsetLeft };
  div.remove();
  return xy;
}

function acRender() {
  const dd = $('template-ac');
  if (!AC.open) {
    dd.classList.add('hidden');
    return;
  }
  dd.innerHTML =
    AC.items
      .map(
        (v, i) => `<div class="ac-item ${i === AC.index ? 'active' : ''}" data-i="${i}">{{${esc(v)}}}</div>`
      )
      .join('') + '<div class="ac-hint">↑↓ navigate · Enter inserts · Esc closes</div>';
  // mousedown (not click) so the textarea doesn't blur first
  dd.querySelectorAll('.ac-item').forEach((el) => {
    el.onmousedown = (e) => {
      e.preventDefault();
      acInsert(Number(el.dataset.i));
    };
  });
  const ta = $('template');
  const { top, left } = caretXY(ta);
  dd.style.top = `${Math.max(0, Math.min(top, ta.offsetHeight - 8))}px`;
  dd.style.left = `${Math.max(0, Math.min(left, ta.clientWidth - 180))}px`;
  dd.classList.remove('hidden');
  const active = dd.querySelector('.ac-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function acUpdate() {
  const found = acDetect();
  if (found) {
    const sameItems = AC.open && JSON.stringify(found.items) === JSON.stringify(AC.items);
    AC.items = found.items;
    AC.matchStart = found.matchStart;
    if (!sameItems) AC.index = 0;
    AC.open = true;
  } else {
    AC.open = false;
  }
  acRender();
}

function acClose() {
  AC.open = false;
  acRender();
}

function acInsert(i) {
  const ta = $('template');
  const v = AC.items[i];
  const insert = `{{${v}}}`;
  const after = ta.value.slice(ta.selectionStart);
  ta.value = ta.value.slice(0, AC.matchStart) + insert + after;
  const pos = AC.matchStart + insert.length;
  ta.focus();
  ta.selectionStart = ta.selectionEnd = pos;
  acClose();
  onTemplateChanged();
}

function acKeydown(e) {
  if (!AC.open) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    AC.index = (AC.index + 1) % AC.items.length;
    acRender();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    AC.index = (AC.index - 1 + AC.items.length) % AC.items.length;
    acRender();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    acInsert(AC.index);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    acClose();
  }
}

function renderPreviewSelect() {
  const sel = $('preview-select');
  const options = S.contacts
    .filter((c) => c.phone)
    .map((c) => `<option value="${c.id}" ${c.id === S.previewId ? 'selected' : ''}>${esc(displayName(c))}</option>`)
    .join('');
  sel.innerHTML = options || '<option value="">(no contacts loaded)</option>';
  sel.onchange = () => {
    S.previewId = Number(sel.value);
    renderPreviewBubble();
    saveDraft();
  };
}

function displayName(c) {
  const get = (...names) => {
    for (const want of names)
      for (const k of Object.keys(c.fields))
        if (k.trim().toLowerCase() === want && String(c.fields[k]).trim()) return String(c.fields[k]).trim();
    return '';
  };
  return (
    [get('firstname', 'first name'), get('lastname', 'last name')].filter(Boolean).join(' ') ||
    c.phone ||
    `row ${c.id + 1}`
  );
}

function renderPreviewBubble() {
  const bubble = $('preview-bubble');
  const p = S.previewId != null ? S.previews.get(S.previewId) : null;
  const template = $('template').value;
  if (!template.trim()) {
    bubble.className = 'bubble muted';
    bubble.textContent = 'Write a message above to see a preview.';
  } else if (!p) {
    bubble.className = 'bubble muted';
    bubble.textContent = 'Load contacts to see a personalized preview.';
  } else {
    bubble.className = 'bubble';
    // Rendered like WhatsApp will render it (*bold*, _italic_, ~strike~,
    // `code`) — waFormatToHtml escapes everything first.
    bubble.innerHTML = waFormatToHtml(p.text);
  }
  renderPreviewWarnings();
}

function renderPreviewWarnings() {
  const el = $('preview-warnings');
  const parts = [];
  const template = $('template').value;
  if (template.trim() && S.contacts.length) {
    const selectedPreviews = [...S.selected].map((id) => ({ id, p: S.previews.get(id) })).filter((x) => x.p);
    const unknown = new Set();
    selectedPreviews.forEach(({ p }) => p.unknown.forEach((u) => unknown.add(u)));
    if (unknown.size) {
      parts.push(
        `<div class="error">Unknown variable(s): <b>${esc([...unknown].join(', '))}</b> — no matching column in your sheet. Sending is blocked until this is fixed.</div>`
      );
    }
    const withEmpty = selectedPreviews.filter(({ p }) => p.empty.length);
    if (withEmpty.length) {
      const names = withEmpty
        .slice(0, 5)
        .map(({ id }) => {
          const c = S.contacts.find((x) => x.id === id);
          const p = S.previews.get(id);
          return `${esc(displayName(c))} (${esc(p.empty.join(', '))})`;
        })
        .join(', ');
      parts.push(
        `<div class="notice">${withEmpty.length} selected contact(s) have empty values and will be <b>skipped as failed</b>, not sent a broken message: ${names}${withEmpty.length > 5 ? ', …' : ''}
        <button type="button" id="btn-deselect-empty">Deselect them</button></div>`
      );
    }
  }
  el.innerHTML = parts.join('');
  const btn = $('btn-deselect-empty');
  if (btn) {
    btn.onclick = () => {
      [...S.selected].forEach((id) => {
        const p = S.previews.get(id);
        if (p && p.empty.length) S.selected.delete(id);
      });
      renderContacts();
      renderPreviewWarnings();
      saveDraft();
    };
  }
  renderRunButton();
}

const refreshPreviews = debounce(async () => {
  renderPreviewSelect();
  const template = $('template').value;
  if (!template.trim() || !S.contacts.length) {
    S.previews = new Map();
    renderPreviewBubble();
    return;
  }
  try {
    const { previews } = await api('/api/preview-all', {
      method: 'POST',
      body: { template, contacts: S.contacts.map((c) => ({ id: c.id, fields: c.fields })) },
    });
    S.previews = new Map(previews.map((p) => [p.id, p]));
  } catch {
    S.previews = new Map();
  }
  renderPreviewBubble();
}, 250);

// ---------- Card 5: Send ----------
function selectedHasBlockingProblems() {
  const selectedPreviews = [...S.selected].map((id) => S.previews.get(id)).filter(Boolean);
  return selectedPreviews.some((p) => p.unknown.length > 0);
}

function renderRunButton() {
  const btn = $('btn-run');
  const n = S.selected.size;
  btn.textContent = S.running ? 'Sending…' : `Send to ${n} ${n === 1 ? 'person' : 'people'}`;
  btn.disabled =
    S.running || S.wa.status !== 'ready' || n === 0 || !$('template').value.trim() || selectedHasBlockingProblems();
  $('btn-schedule').disabled = btn.disabled;
  $('btn-test').disabled = S.wa.status !== 'ready' || !$('template').value.trim() || S.previewId == null;
}

function getDelaysMs() {
  const min = Math.max(1, Number($('delay-min').value) || 4) * 1000;
  const max = Math.max(1, Number($('delay-max').value) || 10) * 1000;
  return { delayMinMs: Math.min(min, max), delayMaxMs: Math.max(min, max) };
}

async function testSend() {
  const status = $('test-status');
  status.textContent = 'Sending…';
  try {
    const contact = S.contacts.find((c) => c.id === S.previewId);
    await api('/api/test-send', {
      method: 'POST',
      body: { template: $('template').value, fields: contact.fields },
    });
    // Timestamp so a repeat test-send visibly updates the line.
    status.textContent = `✓ Sent to your own WhatsApp at ${new Date().toLocaleTimeString()} (rendered for ${displayName(contact)})`;
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
  }
}

function showRunConfirm() {
  $('schedule-form').classList.add('hidden');
  const n = S.selected.size;
  const { delayMinMs, delayMaxMs } = getDelaysMs();
  const etaSec = Math.round((n * (delayMinMs + delayMaxMs)) / 2 / 1000);
  const eta = etaSec > 90 ? `~${Math.round(etaSec / 60)} minutes` : `~${etaSec} seconds`;
  const from = S.wa.self?.number || 'your number';
  const el = $('run-confirm');
  el.innerHTML = `
    <b>Ready to send?</b>
    <p>This will send a personalized message to <b>${n}</b> ${n === 1 ? 'person' : 'people'} from <b>${esc(from)}</b>.
    Estimated time: ${eta}. You can walk away — a report is saved when it finishes.</p>
    <div class="row">
      <button id="btn-confirm-run" class="primary">Yes, send now</button>
      <button id="btn-abort-run">Cancel</button>
    </div>`;
  el.classList.remove('hidden');
  $('btn-abort-run').onclick = () => el.classList.add('hidden');
  $('btn-confirm-run').onclick = startRun;
}

async function startRun() {
  $('run-confirm').classList.add('hidden');
  const contacts = S.contacts.filter((c) => S.selected.has(c.id));
  const { delayMinMs, delayMaxMs } = getDelaysMs();
  // Reset the progress UI before the request — the first SSE progress event
  // can arrive before the fetch resolves and must not be wiped.
  S.progressCount = 0;
  S.totalToSend = contacts.length;
  S.reportFilter = { sent: true, failed: true, cancelled: true };
  $('run-report').classList.add('hidden');
  $('run-report').innerHTML = '';
  $('progress-list').innerHTML = '';
  const stale = $('progress-empty');
  if (stale) stale.remove();
  $('progress-bar').style.width = '0%';
  $('progress-label').textContent = `0 / ${contacts.length}`;
  $('btn-cancel').classList.remove('hidden');
  $('run-progress').classList.remove('hidden');
  try {
    await api('/api/run', {
      method: 'POST',
      body: { contacts, template: $('template').value, delayMinMs, delayMaxMs },
    });
    S.running = true;
  } catch (err) {
    $('run-progress').classList.add('hidden');
    showRunError(err.message);
  }
  renderRunButton();
}

function showRunError(message) {
  const el = $('run-report');
  el.innerHTML = `<div class="error">Run failed: ${esc(message)}</div>`;
  el.classList.remove('hidden');
}

// ---------- Scheduled sends ----------
function toLocalInputValue(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function relTime(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.round(h / 24)}d`;
}

function showScheduleForm() {
  $('run-confirm').classList.add('hidden');
  const n = S.selected.size;
  const from = S.wa.self?.number || 'your number';
  const def = new Date(Date.now() + 3600000);
  def.setMinutes(0, 0, 0);
  const el = $('schedule-form');
  el.innerHTML = `
    <b>Schedule this send</b>
    <p><b>${n}</b> ${n === 1 ? 'person' : 'people'} from <b>${esc(from)}</b>. The recipients and message are
    snapshotted now — later sheet edits won't change this send.</p>
    <div class="row">
      <input type="datetime-local" id="sched-at" value="${toLocalInputValue(def)}" min="${toLocalInputValue(new Date())}" />
      <button id="btn-sched-confirm" class="primary">Schedule</button>
      <button id="btn-sched-abort">Cancel</button>
    </div>
    <div id="sched-result"></div>`;
  el.classList.remove('hidden');
  $('btn-sched-abort').onclick = () => el.classList.add('hidden');
  $('btn-sched-confirm').onclick = async () => {
    const when = new Date($('sched-at').value);
    const resEl = $('sched-result');
    // datetime-local truncates seconds, so "this minute" parses up to 59s in
    // the past — allow the same 60s grace as the server ("send now-ish").
    if (!(when.getTime() > Date.now() - 60000)) {
      resEl.innerHTML = '<div class="error">Pick a time in the future.</div>';
      return;
    }
    try {
      const { agent } = await api('/api/schedule', {
        method: 'POST',
        body: {
          sendAt: when.toISOString(),
          contacts: S.contacts.filter((c) => S.selected.has(c.id)),
          template: $('template').value,
          delayMinMs: getDelaysMs().delayMinMs,
          delayMaxMs: getDelaysMs().delayMaxMs,
        },
      });
      el.classList.add('hidden');
      if (!agent.installed) {
        showRunError(`${agent.error || 'Background agent not installed'} — this send will only fire while the app is open.`);
      }
    } catch (err) {
      resEl.innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
  };
}

function renderSchedule() {
  const el = $('schedule-list');
  if (!S.schedule.length) {
    el.innerHTML = '';
    return;
  }
  const rank = (c) => (c.status === 'pending' || c.status === 'running' ? 0 : 1);
  const items = [...S.schedule].sort(
    (a, b) => rank(a) - rank(b) || (rank(a) === 0 ? Date.parse(a.sendAt) - Date.parse(b.sendAt) : Date.parse(b.sendAt) - Date.parse(a.sendAt))
  );
  const fmt = (iso) =>
    new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  el.innerHTML =
    '<div class="sched-title">Scheduled sends</div>' +
    items
      .slice(0, 10)
      .map((c) => {
        const n = c.contacts.length;
        let detail = '';
        if (c.status === 'pending') {
          const ms = Date.parse(c.sendAt) - Date.now();
          const when = ms > 0 ? `in ${relTime(ms)}` : c.waitReason ? `<span class="sched-err">due — waiting for WhatsApp (${esc(c.waitReason)})</span>` : 'due now';
          detail = `${when} <button class="sched-cancel" data-id="${esc(c.id)}">Cancel</button>`;
        } else if (c.status === 'running') {
          detail = 'sending now…';
        } else if (c.status === 'done' && c.summary) {
          detail = `<span class="st-sent">${c.summary.sent} sent</span>${c.summary.failed ? ` <span class="st-failed">${c.summary.failed} failed</span>` : ''}`;
        } else if (c.error) {
          detail = `<span class="sched-err">${esc(c.error)}</span>`;
        }
        return `<div class="sched-item">
          <span class="sched-when">📅 ${esc(fmt(c.sendAt))}</span>
          <span>${n} ${n === 1 ? 'person' : 'people'}</span>
          <span class="sched-status ${esc(c.status)}">${esc(c.status)}</span>
          <span class="muted">“${esc(c.template.slice(0, 48))}${c.template.length > 48 ? '…' : ''}”</span>
          ${detail}
        </div>`;
      })
      .join('');

  el.querySelectorAll('.sched-cancel').forEach((btn) => {
    btn.onclick = () => api('/api/schedule/cancel', { method: 'POST', body: { id: btn.dataset.id } }).catch(() => {});
  });
}

function onRunProgress(e) {
  S.running = true;
  S.progressCount = e.index + 1;
  S.totalToSend = e.total;
  $('btn-cancel').classList.remove('hidden'); // a scheduled run may start without startRun()
  $('run-progress').classList.remove('hidden');
  $('progress-bar').style.width = `${(S.progressCount / e.total) * 100}%`;
  $('progress-label').textContent = `${S.progressCount} / ${e.total}`;
  const icons = { sent: '✅', failed: '❌', cancelled: '⚠️' };
  const div = document.createElement('div');
  div.className = 'progress-item';
  div.dataset.status = e.status;
  div.hidden = S.reportFilter[e.status] === false;
  div.innerHTML = `<span class="st-${e.status}">${icons[e.status] || ''}</span>
    <span class="who">${esc(e.name)}</span>
    <span class="muted">${esc(e.phone || '')}</span>
    <span class="why">${esc(e.error || '')}</span>`;
  const list = $('progress-list');
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  renderRunButton();
}

function onRunDone(e) {
  S.running = false;
  $('btn-cancel').classList.add('hidden'); // nothing left to cancel
  const s = e.summary;
  const el = $('run-report');
  const chip = (status, n, label) =>
    `<button type="button" class="report-chip st-${status} ${S.reportFilter[status] === false ? 'off' : ''}" data-status="${status}"
       title="Show or hide the ${label} contacts in the list above"><b>${n}</b> ${label}</button>`;
  el.innerHTML = `
    <h2>Run complete</h2>
    <div class="report-summary">
      ${chip('sent', s.sent, 'sent')}
      ${chip('failed', s.failed, 'failed')}
      ${s.cancelled ? chip('cancelled', s.cancelled, 'cancelled') : ''}
    </div>
    ${
      e.reportFile
        ? `<p class="muted">Full report saved to <code>${esc(S.paths && S.paths.reportsDir ? `${S.paths.reportsDir}/${e.reportFile}` : `reports/${e.reportFile}`)}</code>
           <button id="btn-show-report" class="small">Show in Finder</button></p>`
        : ''
    }`;
  el.classList.remove('hidden');
  const reveal = $('btn-show-report');
  if (reveal) reveal.onclick = () => api('/api/open-folder', { method: 'POST', body: { what: 'reports' } }).catch(() => {});
  el.querySelectorAll('.report-chip').forEach((btn) => {
    btn.onclick = () => {
      const st = btn.dataset.status;
      S.reportFilter[st] = S.reportFilter[st] === false;
      applyReportFilter();
    };
  });
  applyReportFilter();
  refreshHistory(); // the "Last sent" column just changed
  renderRunButton();
}

// Hide/show list rows by status; grey the chips that are off; explain an
// empty list rather than leaving a blank.
function applyReportFilter() {
  const list = $('progress-list');
  let visible = 0;
  list.querySelectorAll('.progress-item').forEach((row) => {
    const on = S.reportFilter[row.dataset.status] !== false;
    row.hidden = !on;
    if (on) visible++;
  });
  document.querySelectorAll('.report-chip').forEach((btn) => btn.classList.toggle('off', S.reportFilter[btn.dataset.status] === false));
  let empty = $('progress-empty');
  const anyRows = list.querySelector('.progress-item');
  if (anyRows && visible === 0) {
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'progress-empty';
      list.insertAdjacentElement('afterend', empty);
    }
    empty.textContent = 'No message status selected. Select the statuses below that you wish to display.';
  } else if (empty) {
    empty.remove();
  }
}

// ---------- Draft persistence ----------
const saveDraft = debounce(() => {
  const filters = {};
  for (const [h, sel] of Object.entries(S.filters)) {
    if (sel && sel.size) filters[h] = [...sel];
  }
  S.savedFilters = filters;
  api('/api/draft', {
    method: 'POST',
    body: {
      template: $('template').value,
      sheetUrl: $('sheet-url').value,
      tabName: $('tab-name').value,
      delayMinMs: getDelaysMs().delayMinMs,
      delayMaxMs: getDelaysMs().delayMaxMs,
      filters,
      contactsCache: S.contactsCache,
      selectedIds: [...S.selected],
      previewId: S.previewId,
      activeTab: S.lastTab,
    },
  }).catch(() => {});
}, 600);

function onTemplateChanged() {
  refreshPreviews();
  renderRunButton();
  saveDraft();
}

// Inside the Mac app shell the header doubles as the frameless window's
// titlebar — the class adds traffic-light inset + drag region.
if (navigator.userAgent.includes('Electron')) document.body.classList.add('in-app');

// ---------- Views (toolbar tabs + setup) ----------
// Setup (WhatsApp + Google cards) is not a tab: it opens via the gear / the
// WhatsApp status capsule, opens itself when the connection needs a human
// (first run, QR re-link), and steps aside once connected.
const TAB_VIEWS = ['contacts', 'message'];
let setupPinned = false; // user opened Setup deliberately — don't auto-leave

function setView(view, { save = true } = {}) {
  if (!TAB_VIEWS.includes(view) && view !== 'setup') view = 'contacts';
  document.body.dataset.view = view;
  if (TAB_VIEWS.includes(view)) S.lastTab = view;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('btn-setup').classList.toggle('active', view === 'setup');
  if (view !== 'setup') setupPinned = false;
  if (save) saveDraft();
}

function openSetup(pinned) {
  setupPinned = pinned;
  setView('setup', { save: false });
}

// ---------- Boot ----------
// What the launch-time auto-updater did (from update.local.json via /api/state).
function renderBootNotice(state) {
  const el = $('boot-notice');
  const u = state.update || {};
  const m = state.migration;
  const parts = [];
  if (u.updated) {
    parts.push(`<div class="notice">⬆️ whatsapp-web.js auto-updated <b>v${esc(u.previous)} → v${esc(u.installed)}</b> at launch.${
      u.patchRetired ? ' The local compatibility patch was retired — if sends start failing, see CLAUDE.md → auto-update recovery.' : ''
    }</div>`);
  } else if (u.error) {
    parts.push(`<div class="notice">Auto-update check failed at launch (${esc(u.error)}) — running whatsapp-web.js v${esc(u.installed || '?')}.</div>`);
  }
  // A pinned engine (packaged app) has nothing to announce.
  if (m && m.migrated && m.to) {
    parts.push(`<div class="notice">📦 Your data now lives in <b>${esc(m.to)}</b> — moved from ${esc(m.from)}; the old copies were left in place.</div>`);
  }
  el.innerHTML = parts.join('');
  el.classList.toggle('hidden', parts.length === 0);
}

async function boot() {
  const state = await api('/api/state');
  S.mock = state.mock;
  S.wa = state.wa;
  S.google = state.google;
  S.running = state.running;
  S.schedule = state.schedule || [];
  S.version = state.version;
  S.paths = state.paths || null;
  try {
    S.history = (await api('/api/history')).byPhone || {};
  } catch {
    S.history = {};
  }
  sessionStorage.removeItem('wt-reloaded-401'); // authenticated fine — re-arm the stale-token reload
  if (state.version) $('app-version').textContent = `v${state.version}`;

  const d = state.draft || {};
  if (d.template) $('template').value = d.template;
  if (d.sheetUrl) $('sheet-url').value = d.sheetUrl;
  if (d.tabName) $('tab-name').value = d.tabName;
  if (d.delayMinMs) $('delay-min').value = Math.round(d.delayMinMs / 1000);
  if (d.delayMaxMs) $('delay-max').value = Math.round(d.delayMaxMs / 1000);
  if (d.filters && typeof d.filters === 'object') S.savedFilters = d.filters;

  // Repopulate the contact list and selection exactly as they were before the
  // last shutdown (skipped after `npm start --fresh` — the draft is empty).
  if (d.contactsCache && Array.isArray(d.contactsCache.contacts) && d.contactsCache.contacts.length) {
    setContacts(d.contactsCache, {
      restore: { selectedIds: d.selectedIds, previewId: d.previewId, loadedAt: d.contactsCache.loadedAt },
    });
  }

  renderBootNotice(state);
  renderPills();
  renderWa();
  renderGoogle();
  renderDataCard();
  renderPreviewSelect();
  renderPreviewBubble();
  renderRunButton();

  // Initial view: setup owns the screen until WhatsApp is connected;
  // otherwise land on the last-used tab.
  if (TAB_VIEWS.includes(d.activeTab)) S.lastTab = d.activeTab;
  if (S.wa.status === 'ready') setView(S.lastTab, { save: false });
  else openSetup(false);

  if (S.running) {
    $('run-progress').classList.remove('hidden');
    $('progress-label').textContent = 'Run in progress — new events will appear here.';
  } else if (state.lastRun) {
    onRunDone(state.lastRun); // page reloaded after a run finished — show its result
  }

  // Live events
  const es = new EventSource('/api/events');
  es.addEventListener('wa_state', (e) => {
    const prev = S.wa.status;
    S.wa = JSON.parse(e.data);
    renderPills();
    renderWa();
    // Connection now needs a human (fresh link / re-link) → surface Setup;
    // connection just established during auto-opened Setup → move along.
    if (S.wa.status === 'qr' && document.body.dataset.view !== 'setup') openSetup(false);
    else if (S.wa.status === 'ready' && prev !== 'ready' && document.body.dataset.view === 'setup' && !setupPinned) {
      setView(S.lastTab, { save: false });
    }
  });
  es.addEventListener('google_status', (e) => {
    S.google = JSON.parse(e.data);
    renderPills();
    renderGoogle();
  });
  es.addEventListener('run_progress', (e) => onRunProgress(JSON.parse(e.data)));
  es.addEventListener('run_done', (e) => onRunDone(JSON.parse(e.data)));
  es.addEventListener('schedule', (e) => {
    S.schedule = JSON.parse(e.data).schedule;
    renderSchedule();
  });
  es.addEventListener('run_error', (e) => {
    S.running = false;
    showRunError(JSON.parse(e.data).error);
    renderRunButton();
  });
  // EventSource auto-reconnects but replays nothing — a run_done broadcast
  // during a dropped connection would otherwise strand the UI in "Sending…".
  es.onopen = async () => {
    try {
      const st = await api('/api/state');
      // A different version answering means the server was restarted on new
      // code (or this is a stale tab from an older instance) — reload so the
      // page and server agree.
      if (st.version && S.version && st.version !== S.version) {
        location.reload();
        return;
      }
      S.wa = st.wa;
      S.google = st.google;
      if (S.running && !st.running) {
        if (st.lastRun) onRunDone(st.lastRun);
        else S.running = false;
      }
      renderPills();
      renderWa();
      renderRunButton();
    } catch {
      /* server unreachable; EventSource will retry */
    }
  };

  // Wire inputs
  $('template').addEventListener('input', onTemplateChanged);
  $('template').addEventListener('input', acUpdate);
  $('template').addEventListener('keydown', acKeydown);
  $('template').addEventListener('click', acUpdate);
  $('template').addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) acUpdate();
  });
  $('template').addEventListener('blur', () => setTimeout(acClose, 100));
  $('sheet-url').addEventListener('input', saveDraft);
  $('tab-name').addEventListener('input', saveDraft);
  $('delay-min').addEventListener('change', saveDraft);
  $('delay-max').addEventListener('change', saveDraft);

  $('btn-load-sheet').onclick = async () => {
    const btn = $('btn-load-sheet');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      setContacts(await api('/api/contacts/sheet', { method: 'POST', body: { sheetUrl: $('sheet-url').value, tabName: $('tab-name').value } }));
    } catch (err) {
      setContacts({ headers: [], contacts: [], error: err.message });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Load from Sheet';
    }
  };
  $('btn-load-csv').onclick = async () => {
    try {
      setContacts(await api('/api/contacts/csv', { method: 'POST', body: { csv: $('csv-text').value } }), { source: 'csv' });
    } catch (err) {
      setContacts({ headers: [], contacts: [], error: err.message });
    }
  };
  $('btn-test').onclick = testSend;
  $('btn-run').onclick = showRunConfirm;
  $('btn-schedule').onclick = showScheduleForm;
  $('btn-cancel').onclick = () => api('/api/run/cancel', { method: 'POST' }).catch(() => {});

  document.querySelectorAll('#tabs button').forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
  });
  $('btn-show-reports').onclick = () => api('/api/open-folder', { method: 'POST', body: { what: 'reports' } }).catch(() => {});
  $('btn-show-logs').onclick = () => api('/api/open-folder', { method: 'POST', body: { what: 'logs' } }).catch(() => {});
  $('btn-fresh').onclick = () => {
    const box = $('fresh-confirm');
    box.innerHTML = `<p>Start fresh? The message, loaded contacts and selection are set aside (kept as <code>draft.backup.local.json</code>); WhatsApp and Google stay connected.</p>
      <div class="row"><button id="btn-fresh-yes" class="danger">Yes, start fresh</button><button id="btn-fresh-no">Cancel</button></div>`;
    box.classList.remove('hidden');
    $('btn-fresh-no').onclick = () => box.classList.add('hidden');
    $('btn-fresh-yes').onclick = async () => {
      try {
        await api('/api/draft/reset', { method: 'POST' });
        location.reload();
      } catch (err) {
        box.innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    };
  };
  $('btn-setup').onclick = () => openSetup(true);
  $('pill-wa').onclick = () => openSetup(true);

  renderSchedule();
  // Keep pending countdowns fresh.
  setInterval(() => {
    if (S.schedule.some((c) => c.status === 'pending')) renderSchedule();
  }, 30000);
}

boot();
