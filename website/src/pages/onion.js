import '../theme.css';
import '../tools.css';
import { mountChrome } from '../chrome.js';
import { renderResponse } from '../responseView.js';

mountChrome('onion');
document.body.classList.add('has-drawer');

const $ = (id) => document.getElementById(id);
const dot = $('dot'), statusEl = $('status');
const carrierSel = $('carrier'), coldBox = $('cold');
const connectBtn = $('connect'), disconnectBtn = $('disconnect');
const stepRequest = $('step-request'), stepResponse = $('step-response');
const urlInput = $('url'), followBox = $('follow'), fetchBtn = $('fetch');
const responseEl = $('response'), hopsEl = $('hops');
const logEl = $('log'), logDrawer = $('log-drawer'), logToggle = $('log-toggle');
const logLatest = $('log-latest'), logCount = $('log-count');

let client = null;
let TorLib = null; // imported on connect, so the WASM only loads when asked
let count = 0;

function setStatus(state, text) {
  dot.className = 'dot' + (state ? ' ' + state : '');
  statusEl.textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

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
  if (open) logEl.scrollTop = logEl.scrollHeight;
});
$('clear-log').addEventListener('click', () => {
  logEl.innerHTML = '';
  count = 0;
  logCount.textContent = '0';
  logLatest.textContent = 'Cleared';
});

/** Snowflake bridge lines for the chosen carrier. */
function bridgesFor(carrier, lib) {
  if (carrier === 'websocket') return [...lib.SNOWFLAKE_BRIDGES];
  if (carrier === 'webrtc') return [...lib.SNOWFLAKE_WEBRTC_BRIDGES];
  throw new Error(`unknown carrier ${carrier}`);
}

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  carrierSel.disabled = coldBox.disabled = true;
  setStatus('loading', 'Connecting…');
  log('info', 'Loading tor-js…');

  try {
    if (!TorLib) TorLib = await import('tor-js/wasm-base64');
    const { TorClient, Log, storage } = TorLib;
    const t0 = performance.now();
    client = new TorClient({
      bridges: bridgesFor(carrierSel.value, TorLib),
      log: new Log({ rawLog: (level, ...args) => log(level, args.join(' ')) }),
      logLevel: 'info',
      ...(coldBox.checked ? { storage: new storage.MemoryStorage() } : {}),
    });
    const tick = setInterval(() => {
      setStatus('loading', `Connecting… ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }, 1000);
    try {
      await client.ready();
    } finally {
      clearInterval(tick);
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus('ok', `Connected in ${secs}s`);
    log('info', `Ready in ${secs}s`);
    disconnectBtn.disabled = false;
    stepRequest.classList.remove('locked');
    stepResponse.classList.remove('locked');
  } catch (e) {
    setStatus('err', 'Connection failed');
    log('error', e?.message || String(e));
    client?.close();
    client = null;
    connectBtn.disabled = false;
    carrierSel.disabled = coldBox.disabled = false;
  }
});

disconnectBtn.addEventListener('click', () => {
  client?.close();
  client = null;
  setStatus('', 'Disconnected');
  connectBtn.disabled = false;
  carrierSel.disabled = coldBox.disabled = false;
  disconnectBtn.disabled = true;
  stepRequest.classList.add('locked');
  stepResponse.classList.add('locked');
});

fetchBtn.addEventListener('click', async () => {
  let url = urlInput.value.trim();
  if (!url) { log('error', 'Enter a URL'); return; }
  fetchBtn.disabled = true;
  responseEl.className = 'response empty';
  responseEl.textContent = 'Requesting… (the first request to an onion service builds its circuits)';
  hopsEl.textContent = '';
  const t0 = performance.now();
  const hops = [];
  try {
    // tor-js's fetch does not follow redirects; DuckDuckGo's onion sends
    // http:// to https://, so follow a few here when asked.
    let res;
    for (let hop = 0; ; hop++) {
      log('info', `Fetching ${url}`);
      res = await client.fetch(url);
      const location = res.headers.get('location');
      if (!followBox.checked || !location || res.status < 300 || res.status >= 400 || hop === 5) break;
      await res.body?.cancel();
      hops.push(`${res.status} ${url}`);
      url = new URL(location, url).href;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    log('info', `${res.status} in ${secs}s (${bytes.length} bytes)`);
    hopsEl.textContent = hops.length ? `Redirects: ${hops.join(' → ')} → ${url}` : '';
    renderResponse(responseEl, { url, status: res.status, statusText: res.statusText, headers: res.headers, bytes, seconds: secs });
  } catch (e) {
    log('error', e?.message || String(e));
    responseEl.className = 'response';
    responseEl.innerHTML = `<span class="rstatus bad">error</span><div class="rbody">${escapeHtml(e?.message || String(e))}</div>`;
  } finally {
    fetchBtn.disabled = false;
  }
});
