'use strict';

// ---------- State ----------
const S = {
  mock: false,
  wa: { status: 'starting' },
  google: { configured: false, connected: false },
  headers: [],
  contacts: [],
  selected: new Set(),
  previews: new Map(), // contact id -> { text, unknown, empty }
  previewId: null,
  running: false,
  progressCount: 0,
  totalToSend: 0,
};

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
  const [label, cls] = map[S.wa.status] || [S.wa.status, 'warn'];
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
  if (st.status === 'qr') {
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
    $('btn-g-connect').onclick = () => window.open('/api/google/connect', '_blank');
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
}

// ---------- Card 3: Contacts ----------
function setContacts(data) {
  S.headers = data.headers || [];
  S.contacts = data.contacts || [];
  S.selected = new Set(S.contacts.filter((c) => c.phone).map((c) => c.id));
  S.previewId = S.contacts.find((c) => c.phone)?.id ?? null;
  const errEl = $('contacts-error');
  if (data.error) {
    errEl.textContent = data.error;
    errEl.classList.remove('hidden');
  } else {
    errEl.classList.add('hidden');
  }
  renderContacts();
  renderChips();
  refreshPreviews();
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
        ${cells}${phoneCell}
      </tr>`;
    })
    .join('');
  const validIds = S.contacts.filter((c) => c.phone).map((c) => c.id);
  const allSelected = validIds.length > 0 && validIds.every((id) => S.selected.has(id));
  wrap.innerHTML = `
    <table>
      <thead><tr>
        <th><input type="checkbox" id="check-all" ${allSelected ? 'checked' : ''} /></th>
        ${headers.filter((h) => h.toLowerCase() !== 'phone').map((h) => `<th>${esc(h)}</th>`).join('')}
        <th>Phone</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="count-line" id="count-line"></div>`;

  wrap.querySelectorAll('tbody input[type=checkbox]').forEach((cb) => {
    cb.onchange = () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) S.selected.add(id);
      else S.selected.delete(id);
      renderCountLine();
      renderRunButton();
      renderPreviewWarnings();
    };
  });
  $('check-all').onchange = (e) => {
    S.selected = new Set(e.target.checked ? S.contacts.filter((c) => c.phone).map((c) => c.id) : []);
    renderContacts();
    renderRunButton();
    renderPreviewWarnings();
  };
  renderCountLine();
  renderRunButton();
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
    bubble.textContent = p.text;
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
    status.textContent = `✓ Sent to your own WhatsApp (rendered for ${displayName(contact)})`;
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
  }
}

function showRunConfirm() {
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
  $('run-report').classList.add('hidden');
  $('run-report').innerHTML = '';
  $('progress-list').innerHTML = '';
  $('progress-bar').style.width = '0%';
  $('progress-label').textContent = `0 / ${contacts.length}`;
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

function onRunProgress(e) {
  S.running = true;
  S.progressCount = e.index + 1;
  S.totalToSend = e.total;
  $('run-progress').classList.remove('hidden');
  $('progress-bar').style.width = `${(S.progressCount / e.total) * 100}%`;
  $('progress-label').textContent = `${S.progressCount} / ${e.total}`;
  const icons = { sent: '✅', failed: '❌', cancelled: '⚠️' };
  const div = document.createElement('div');
  div.className = 'progress-item';
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
  const s = e.summary;
  const el = $('run-report');
  el.innerHTML = `
    <h2>Run complete</h2>
    <div class="report-summary">
      <span class="st-sent"><b>${s.sent}</b> sent</span>
      <span class="st-failed"><b>${s.failed}</b> failed</span>
      ${s.cancelled ? `<span class="st-cancelled"><b>${s.cancelled}</b> cancelled</span>` : ''}
    </div>
    ${e.reportFile ? `<p class="muted">Full report saved to <code>reports/${esc(e.reportFile)}</code></p>` : ''}`;
  el.classList.remove('hidden');
  renderRunButton();
}

// ---------- Draft persistence ----------
const saveDraft = debounce(() => {
  api('/api/draft', {
    method: 'POST',
    body: {
      template: $('template').value,
      sheetUrl: $('sheet-url').value,
      tabName: $('tab-name').value,
      delayMinMs: getDelaysMs().delayMinMs,
      delayMaxMs: getDelaysMs().delayMaxMs,
    },
  }).catch(() => {});
}, 600);

function onTemplateChanged() {
  refreshPreviews();
  renderRunButton();
  saveDraft();
}

// ---------- Boot ----------
async function boot() {
  const state = await api('/api/state');
  S.mock = state.mock;
  S.wa = state.wa;
  S.google = state.google;
  S.running = state.running;

  const d = state.draft || {};
  if (d.template) $('template').value = d.template;
  if (d.sheetUrl) $('sheet-url').value = d.sheetUrl;
  if (d.tabName) $('tab-name').value = d.tabName;
  if (d.delayMinMs) $('delay-min').value = Math.round(d.delayMinMs / 1000);
  if (d.delayMaxMs) $('delay-max').value = Math.round(d.delayMaxMs / 1000);

  renderPills();
  renderWa();
  renderGoogle();
  renderPreviewSelect();
  renderPreviewBubble();
  renderRunButton();

  if (S.running) {
    $('run-progress').classList.remove('hidden');
    $('progress-label').textContent = 'Run in progress — new events will appear here.';
  } else if (state.lastRun) {
    onRunDone(state.lastRun); // page reloaded after a run finished — show its result
  }

  // Live events
  const es = new EventSource('/api/events');
  es.addEventListener('wa_state', (e) => {
    S.wa = JSON.parse(e.data);
    renderPills();
    renderWa();
  });
  es.addEventListener('google_status', (e) => {
    S.google = JSON.parse(e.data);
    renderPills();
    renderGoogle();
  });
  es.addEventListener('run_progress', (e) => onRunProgress(JSON.parse(e.data)));
  es.addEventListener('run_done', (e) => onRunDone(JSON.parse(e.data)));
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
      setContacts(await api('/api/contacts/csv', { method: 'POST', body: { csv: $('csv-text').value } }));
    } catch (err) {
      setContacts({ headers: [], contacts: [], error: err.message });
    }
  };
  $('btn-test').onclick = testSend;
  $('btn-run').onclick = showRunConfirm;
  $('btn-cancel').onclick = () => api('/api/run/cancel', { method: 'POST' }).catch(() => {});
}

boot();
