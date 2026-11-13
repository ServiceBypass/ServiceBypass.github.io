const $ = id => document.getElementById(id);
let apiOrigin = '', adminKey = '', busy = false;
const offsets = { licenses: 0, reports: 0 };
const totals = { licenses: 0, reports: 0 };
const pageSize = 25;

function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
async function run(fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  notice('Working…');
  try { await fn(); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; document.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}
function click(id, fn) { $(id).addEventListener('click', () => run(fn)); }
function form(id, fn) { $(id).addEventListener('submit', e => { e.preventDefault(); run(() => fn(new FormData(e.target), e.target)); }); }
async function api(path, method = 'GET', data) {
  if (!adminKey || !apiOrigin) throw new Error('Connect to your API first.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${apiOrigin}${path}`, {
      method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { Authorization: `Bearer ${adminKey}`, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${result.error?.message || `HTTP ${response.status}`} (${result.error?.code || 'request_failed'})`);
    return result;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out. Refresh before retrying a write: it may already have committed.');
    if (e instanceof TypeError) throw new Error('Connection failed. Check the API origin, TLS, and server ALLOWED_ORIGINS.');
    throw e;
  } finally { clearTimeout(timeout); }
}
function record(container, title, value, actions = []) {
  const article = document.createElement('article'); article.className = 'record';
  const heading = document.createElement('h3'); heading.textContent = title;
  const detail = document.createElement('pre'); detail.textContent = JSON.stringify(value, null, 2);
  article.append(heading, detail);
  for (const [label, action, danger] of actions) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    if (danger) button.className = 'danger';
    button.addEventListener('click', () => run(action)); article.append(button);
  }
  $(container).append(article);
}
function empty(container) { $(container).replaceChildren(); }
function hideKey() { $('new-key').textContent = ''; $('key-result').hidden = true; }
function disconnect() {
  adminKey = ''; apiOrigin = ''; $('admin-key').value = ''; $('workspace').hidden = true; hideKey();
  for (const id of ['licenses', 'reports', 'files', 'announcements', 'service-status']) empty(id);
  notice('Disconnected. Credentials were removed from this tab.');
}
async function status() {
  const result = await api('/admin/status');
  $('service-status').textContent = JSON.stringify(result, null, 2);
  $('arch-url').value = result.settings.archGlUrl || '';
  $('maintenance').checked = result.settings.maintenance;
  notice(result.initialized ? 'Connected. Storage is ready.' : 'Connected. Click Initialize storage files.');
}
form('connect', async () => {
  const url = new URL($('api-origin').value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !['http://localhost:8787', 'http://127.0.0.1:8787'].includes(url.origin))) {
    throw new Error('Enter an HTTPS API origin only, with no path, query, or credentials.');
  }
  const key = $('admin-key').value;
  disconnect();
  apiOrigin = url.origin; adminKey = key; $('admin-key').value = '';
  try { await status(); $('workspace').hidden = false; }
  catch (e) { disconnect(); throw e; }
});
click('logout', disconnect);
click('hide-key', () => { hideKey(); notice('License key hidden.'); });
click('refresh-status', status);
click('initialize', async () => { await api('/admin/init', 'POST'); await status(); });
form('settings', async () => {
  await api('/admin/settings', 'PATCH', { archGlUrl: $('arch-url').value || null, maintenance: $('maintenance').checked });
  notice('Settings saved.');
});
form('create-license', async data => {
  hideKey();
  const result = await api('/admin/licenses', 'POST', {
    label: data.get('label'), product: data.get('product'), maxDevices: Number(data.get('maxDevices')),
    expiresAt: data.get('expiresAt') ? new Date(data.get('expiresAt')).toISOString() : null,
  });
  $('new-key').textContent = result.licenseKey; $('key-result').hidden = false;
  notice('License created. Copy the key before leaving this page.');
});
form('edit-license', async data => {
  const patch = {};
  if (data.get('label')) patch.label = data.get('label');
  if (data.get('maxDevices')) patch.maxDevices = Number(data.get('maxDevices'));
  if (data.get('expiresAt')) patch.expiresAt = new Date(data.get('expiresAt')).toISOString();
  if (data.get('perpetual')) patch.expiresAt = null;
  if (!Object.keys(patch).length) throw new Error('Enter at least one change.');
  await api(`/admin/licenses/${encodeURIComponent(data.get('id'))}`, 'PATCH', patch);
  notice('License updated. Existing sessions have been invalidated.');
});
async function licenses() {
  const result = await api(`/admin/licenses?offset=${offsets.licenses}&limit=${pageSize}`);
  totals.licenses = result.total;
  $('licenses-page').textContent = `Offset ${result.offset} · ${result.total} total`;
  empty('licenses');
  for (const license of result.items) {
    const path = `/admin/licenses/${license.id}`;
    record('licenses', license.label, license, [
      ['Edit', () => { $('edit-license').elements.id.value = license.id; $('edit-license').scrollIntoView({ behavior: 'smooth' }); notice('Enter the fields you want to change.'); }],
      [license.status === 'active' ? 'Revoke' : 'Reactivate', async () => {
        if (!confirm(`Change status for ${license.label}?`)) { notice('Cancelled.'); return; }
        await api(path, 'PATCH', { status: license.status === 'active' ? 'revoked' : 'active' }); await licenses();
      }, true],
      ['Reset devices', async () => {
        if (!confirm('Clear all devices and invalidate all sessions?')) { notice('Cancelled.'); return; }
        await api(`${path}/reset-devices`, 'POST'); await licenses();
      }],
      ['Delete', async () => {
        if (!confirm(`Permanently delete license ${license.label}?`)) { notice('Cancelled.'); return; }
        await api(path, 'DELETE'); await licenses();
      }, true],
    ]);
  }
  notice('Licenses loaded.');
}
async function announcements() {
  const result = await api('/admin/announcements'); empty('announcements');
  for (const a of result.announcements) record('announcements', a.title, a, [['Delete', async () => {
    if (!confirm('Delete this announcement?')) { notice('Cancelled.'); return; }
    await api(`/admin/announcements/${a.id}`, 'DELETE'); await announcements();
  }, true]]);
  notice('Announcements loaded.');
}
form('create-announcement', async (data, target) => {
  await api('/admin/announcements', 'POST', { title: data.get('title'), message: data.get('message'), active: true });
  target.reset(); await announcements();
});
async function files() {
  const result = await api('/admin/files'); empty('files');
  for (const f of result.files) record('files', f.name, { ...f, downloadPath: `/files/${f.id}` }, [['Delete', async () => {
    if (!confirm('Delete this file? Historical Git versions will still exist.')) { notice('Cancelled.'); return; }
    await api(`/admin/files/${f.id}`, 'DELETE'); await files();
  }, true]]);
  notice('Files loaded.');
}
form('upload-file', async (data, target) => {
  const file = data.get('file');
  if (!file.size || file.size > 256 * 1024) throw new Error('Choose a file between 1 byte and 256 KiB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  await api('/admin/files', 'POST', { name: file.name, product: data.get('product'), contentBase64: btoa(binary) });
  target.reset(); await files();
});
async function reports() {
  const result = await api(`/admin/reports?offset=${offsets.reports}&limit=${pageSize}`);
  totals.reports = result.total; $('reports-page').textContent = `Offset ${result.offset} · ${result.total} total`;
  empty('reports');
  for (const r of result.items) record('reports', `${r.type} · ${r.createdAt}`, r, [['Delete', async () => {
    if (!confirm('Delete this report? Historical Git versions will still exist.')) { notice('Cancelled.'); return; }
    await api(`/admin/reports/${r.id}`, 'DELETE'); await reports();
  }, true]]);
  notice('Reports loaded.');
}
for (const [name, load] of [['licenses', licenses], ['reports', reports]]) {
  click(`refresh-${name}`, load);
  click(`${name}-prev`, async () => { offsets[name] = Math.max(0, offsets[name] - pageSize); await load(); });
  click(`${name}-next`, async () => { if (offsets[name] + pageSize < totals[name]) offsets[name] += pageSize; await load(); });
}
click('refresh-announcements', announcements);
click('refresh-files', files);
window.addEventListener('pagehide', disconnect);
