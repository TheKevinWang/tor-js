import '../theme.css';
import '../tools.css';
import { mountChrome } from '../chrome.js';
import { renderResponse } from '../responseView.js';

mountChrome('host');
document.body.classList.add('has-drawer');

const $ = (id) => document.getElementById(id);
const dot = $('dot'), statusEl = $('status');
const connectBtn = $('connect'), disconnectBtn = $('disconnect');
const stepHost = $('step-host'), stepVisit = $('step-visit');
const hostDot = $('host-dot'), hostStatus = $('host-status'), addressEl = $('address');
const goOnline = $('go-online'), goOffline = $('go-offline'), newIdentity = $('new-identity');
const requestsEl = $('requests');
const urlInput = $('url'), fetchBtn = $('fetch'), responseEl = $('response');
const logEl = $('log'), logDrawer = $('log-drawer'), logToggle = $('log-toggle');
const logLatest = $('log-latest'), logCount = $('log-count');

const KEY = 'tor-js-host-identity';
let client = null;
let TorLib = null; // imported on connect, so the WASM only loads when asked
let service = null;
let releaseLock = null;
let count = 0;

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function log(level, msg) {
  const row = document.createElement('div');
  row.className = 'log-row';
  const cls = { info: 'log-i', error: 'log-err', warn: 'log-err', debug: 'log-t' }[level] || 'log-t';
  const mark = level[0].toUpperCase();
  row.innerHTML = `<span class="log-mark ${cls}">${mark}</span><span>${escapeHtml(msg)}</span>`;
  logEl.appendChild(row);
  while (logEl.children.length > 500) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  logLatest.textContent = `${mark} · ${msg}`;
  logCount.textContent = String(++count);
}
logToggle.addEventListener('click', () => {
  const open = logDrawer.classList.toggle('open');
  logToggle.setAttribute('aria-expanded', String(open));
});
$('clear-log').addEventListener('click', () => { logEl.innerHTML = ''; count = 0; logCount.textContent = '0'; });

function setStatus(state, text) { dot.className = 'dot' + (state ? ' ' + state : ''); statusEl.textContent = text; }
function setHostStatus(state, text) { hostDot.className = 'dot' + (state ? ' ' + state : ''); hostStatus.textContent = text; }

// The identity is the address's secret key: 32 bytes, kept in local storage as base64.
function loadIdentity() {
  try {
    const b64 = localStorage.getItem(KEY);
    if (b64) {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      if (bytes.length === 32) return bytes;
    }
  } catch { /* storage unavailable: fall through to a fresh one */ }
  return null;
}
function saveIdentity(bytes) {
  try { localStorage.setItem(KEY, btoa(String.fromCharCode(...bytes))); } catch { /* not remembered */ }
}
function identity() {
  let id = loadIdentity();
  if (!id) { id = TorLib.TorClient.generateIdentity(); saveIdentity(id); }
  return id;
}
async function showAddress() {
  addressEl.textContent = await TorLib.TorClient.onionAddress(identity());
}

function addRequest(text) {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.innerHTML = `<span class="log-mark log-i">←</span><span>${escapeHtml(new Date().toLocaleTimeString())} ${escapeHtml(text)}</span>`;
  requestsEl.appendChild(row);
  requestsEl.scrollTop = requestsEl.scrollHeight;
}

function page(address) {
  return `<!doctype html><meta charset="utf-8"><title>Hosted from a browser tab</title>
<style>body{font:16px system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem}code{background:#eee;padding:.1em .3em}</style>
<h1>Hello from a browser tab</h1>
<p>This page is served by a web page running in someone's browser, through Tor, at <code>${escapeHtml(address)}</code>. There is no server.</p>
<p>Try <a href="/echo?msg=hello">/echo?msg=hello</a>.</p>`;
}

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  setStatus('loading', 'Connecting…');
  log('info', 'Loading tor-js…');
  try {
    if (!TorLib) TorLib = await import('tor-js/wasm-base64');
    const { TorClient, Log, SNOWFLAKE_BRIDGES } = TorLib;
    const t0 = performance.now();
    client = new TorClient({
      bridges: [...SNOWFLAKE_BRIDGES],
      log: new Log({ rawLog: (level, ...args) => log(level, args.join(' ')) }),
      logLevel: 'info',
      bootstrapUrl: new URL('bootstrap.zip.zst', location.href).href,
    });
    const tick = setInterval(() => setStatus('loading', `Connecting… ${((performance.now() - t0) / 1000).toFixed(0)}s`), 1000);
    try { await client.ready(); } finally { clearInterval(tick); }
    setStatus('ok', `Connected in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    disconnectBtn.disabled = false;
    stepHost.classList.remove('locked');
    stepVisit.classList.remove('locked');
    await showAddress();
  } catch (e) {
    setStatus('err', 'Connection failed');
    log('error', e?.message || String(e));
    client?.close();
    client = null;
    connectBtn.disabled = false;
  }
});

async function stopHosting() {
  service?.close();
  service = null;
  releaseLock?.();
  releaseLock = null;
  goOnline.disabled = false;
  goOffline.disabled = true;
  newIdentity.disabled = false;
  setHostStatus('', 'Offline');
}

disconnectBtn.addEventListener('click', async () => {
  await stopHosting();
  client?.close();
  client = null;
  setStatus('', 'Disconnected');
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  stepHost.classList.add('locked');
  stepVisit.classList.add('locked');
});

goOnline.addEventListener('click', async () => {
  goOnline.disabled = true;
  newIdentity.disabled = true;
  const id = identity();
  const address = await TorLib.TorClient.onionAddress(id);

  // Two tabs hosting one identity would fight over the published descriptor, so one holds a
  // lock per address for as long as it is online.
  if (navigator.locks) {
    const got = await new Promise((resolve) => {
      navigator.locks.request(`tor-js-host:${address}`, { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return; }
        resolve(true);
        return new Promise((release) => { releaseLock = release; });
      });
    });
    if (!got) {
      log('error', 'Another tab or window of this browser is already hosting this address');
      setHostStatus('err', 'Already hosted in another tab');
      goOnline.disabled = false;
      newIdentity.disabled = false;
      return;
    }
  }

  setHostStatus('loading', 'Starting…');
  try {
    service = await client.serve((req) => {
      const url = new URL(req.url);
      addRequest(`${req.method} ${url.pathname}${url.search}`);
      if (url.pathname === '/echo') return new Response(`You said: ${url.searchParams.get('msg') ?? ''}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      if (url.pathname === '/') return new Response(page(address), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain' } });
    }, { identity: id });
    log('info', `Hosting at http://${service.onion}/`);
    setHostStatus('ok', 'Online (it may take a few seconds before visitors can reach it)');
    goOffline.disabled = false;
    urlInput.value = `http://${service.onion}/`;
  } catch (e) {
    log('error', e?.message || String(e));
    setHostStatus('err', 'Could not start');
    await stopHosting();
  }
});

goOffline.addEventListener('click', stopHosting);

newIdentity.addEventListener('click', async () => {
  saveIdentity(TorLib.TorClient.generateIdentity());
  await showAddress();
  log('info', 'New address made; the old one is retired');
});

fetchBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) { log('error', 'Enter a URL'); return; }
  fetchBtn.disabled = true;
  responseEl.className = 'response empty';
  responseEl.textContent = 'Requesting… (the first request to an onion service builds its circuits)';
  const t0 = performance.now();
  try {
    const res = await client.fetch(url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log('info', `${res.status} in ${secs}s (${bytes.length} bytes)`);
    renderResponse(responseEl, { url, status: res.status, statusText: res.statusText, headers: res.headers, bytes, seconds: secs });
  } catch (e) {
    log('error', e?.message || String(e));
    responseEl.className = 'response';
    responseEl.innerHTML = `<span class="rstatus bad">error</span><div class="rbody">${escapeHtml(e?.message || String(e))}</div>`;
  } finally {
    fetchBtn.disabled = false;
  }
});

window.addEventListener('pagehide', () => { service?.close(); });
