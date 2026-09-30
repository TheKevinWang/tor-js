import '../theme.css';
import '../tools.css';
import { mountChrome } from '../chrome.js';
import { renderResponse } from '../responseView.js';

mountChrome('observatory');
document.body.classList.add('has-drawer');

// Onion services verified live through this client. Each is fetched from a
// cold start, so the connect phase includes the onion-service descriptor
// lookup, introduction and rendezvous.
const ONIONS = [
  { name: 'Tor Project', url: 'http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion/' },
  { name: 'DuckDuckGo', url: 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/' },
  { name: 'BBC News', url: 'https://www.bbcnewsd73hkzno2ini43t4gblxvycyac5aw4gnv7t2rccijh7745uqd.onion/' },
  { name: 'Brave Search', url: 'https://search.brave4u7jddbv7cyviptqjc7jusxh72uik7zt6adtckl5f4nwy2v72qd.onion/' },
  { name: 'Riseup', url: 'http://vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion/' },
  { name: 'Proton', url: 'https://protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7ozyd.onion/' },
];
const DDG = 'https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion';
const HEADERS = {
  // What Tor Browser sends, so sites serve their normal pages.
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};
const SITE_DEADLINE_MS = 120_000;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const kb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

let client = null;
let launchedAt = 0;

// ---------------------------------------------------------------- log drawer
let logCount = 0;
function log(level, msg) {
  const row = document.createElement('div');
  row.className = 'log-row';
  const cls = { info: 'log-i', error: 'log-err', warn: 'log-err', debug: 'log-t' }[level] || 'log-t';
  row.innerHTML = `<span class="log-mark ${cls}">${level[0].toUpperCase()}</span><span>${esc(msg)}</span>`;
  $('log').appendChild(row);
  while ($('log').children.length > 800) $('log').removeChild($('log').firstChild);
  $('log-latest').textContent = msg;
  $('log-count').textContent = String(++logCount);
  watchPhases(msg);
}
$('log-toggle').addEventListener('click', () => {
  const open = $('log-drawer').classList.toggle('open');
  $('log-toggle').setAttribute('aria-expanded', String(open));
});
$('clear-log').addEventListener('click', () => { $('log').innerHTML = ''; logCount = 0; $('log-count').textContent = '0'; });

// ------------------------------------------------------------ path diagram
function stage(node, wire, state, sub) {
  const n = $(node);
  n.classList.toggle('busy', state === 'busy');
  n.classList.toggle('on', state === 'on');
  if (wire) $(wire).classList.toggle('on', state === 'on');
  if (sub !== undefined) $(`s-${node.slice(2)}`).textContent = sub;
}
const since = () => secs(performance.now() - launchedAt);
const seen = new Set();
function once(key, fn) { if (!seen.has(key)) { seen.add(key); fn(); } }
function watchPhases(msg) {
  if (/Snowflake: opening/.test(msg)) once('sf-busy', () => stage('n-sf', null, 'busy'));
  if (/Snowflake: ready|Snowflake: session open/.test(msg)) once('sf', () => { stage('n-sf', 'w1', 'on', since()); stage('n-dir', null, 'busy'); });
  if (/Fast bootstrap: done|Loaded a good directory|Directory is complete/.test(msg)) once('dir', () => { stage('n-dir', 'w2', 'on', since()); stage('n-tor', null, 'busy'); });
}

// ------------------------------------------------------------ fetch helper
/** Fetch through Tor, following redirects (tor-js's fetch does not). */
async function torFetch(url, hops = 5) {
  for (let i = 0; ; i++) {
    const res = await client.fetch(url, { headers: HEADERS });
    const loc = res.headers.get('location');
    if (!(res.status >= 300 && res.status < 400 && loc) || i === hops) return { res, url };
    await res.body?.cancel();
    url = new URL(loc, url).href;
  }
}
const withDeadline = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms / 1000}s`)), ms))]);

// --------------------------------------------------------------- waterfall
const rows = ONIONS.map((o) => ({ ...o, start: 0, headers: 0, done: 0, status: null, bytes: 0, title: '', error: '' }));
function renderWaterfall() {
  const now = performance.now();
  const t0 = rows[0].start || now;
  const latest = Math.max(...rows.map((r) => (r.done || r.error ? r.done : now) - t0), 1);
  const span = Math.max(10_000, Math.ceil(latest / 5000) * 5000);
  $('axis').innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${Math.round((span * f) / 1000)}s</span>`).join('');
  $('wf').innerHTML = rows.map((r) => {
    const host = new URL(r.url).host;
    const pct = (t) => `${Math.min(100, (Math.max(0, t - t0) / span) * 100)}%`;
    let segs = '';
    let meta = '';
    if (!r.start) {
      meta = 'queued';
    } else if (r.error) {
      segs = `<div class="wf-seg fail" style="left:0;width:${pct(r.done)}"></div>`;
      meta = `<span class="bad">✕</span> ${esc(r.error)}`;
    } else {
      const hEnd = r.headers || now;
      segs += `<div class="wf-seg ${r.headers ? 'connect' : 'pending'}" style="left:0;width:${pct(hEnd)}"></div>`;
      if (r.headers) {
        const bEnd = r.done || now;
        segs += `<div class="wf-seg body" style="left:${pct(r.headers)};width:calc(${pct(bEnd)} - ${pct(r.headers)} + 2px)"></div>`;
      }
      meta = r.done
        ? `<span class="good">${r.status}</span> · ${secs(r.done - t0)} · ${kb(r.bytes)}${r.title ? ` · <span class="ttl">“${esc(r.title)}”</span>` : ''}`
        : r.headers
          ? `<span class="good">${r.status}</span> · receiving… ${secs(now - t0)}`
          : `finding the service, rendezvous… ${secs(now - t0)}`;
    }
    return `<div class="wf-row"><div class="wf-name"><b>${esc(r.name)}</b><code title="${esc(host)}">${esc(host)}</code></div>`
      + `<div class="wf-track">${segs}</div>`
      + `<div class="wf-meta">${meta}</div>`
      + '</div>';
  }).join('');
}
renderWaterfall();

async function loadOnion(r) {
  r.start = rows[0].start;
  try {
    await withDeadline((async () => {
      const { res } = await torFetch(r.url);
      r.headers = performance.now();
      r.status = res.status;
      const bytes = new Uint8Array(await res.arrayBuffer());
      r.bytes = bytes.length;
      const html = new TextDecoder().decode(bytes);
      r.title = new DOMParser().parseFromString(html, 'text/html').title.trim().slice(0, 90);
      r.done = performance.now();
      once('onion', () => stage('n-onion', 'w4', 'on', since()));
    })(), SITE_DEADLINE_MS);
  } catch (e) {
    r.error = (e?.message || String(e)).replace(/^.*?tor: /, '').slice(0, 60);
    r.done = performance.now();
  }
  const ok = rows.filter((x) => x.done && !x.error).length;
  $('s-onion').textContent = `${ok}/${rows.length} up`;
}

// -------------------------------------------------------------------- exit
async function showExit() {
  try {
    const { res } = await withDeadline(torFetch('https://check.torproject.org/api/ip'), 90_000);
    const { IsTor, IP } = await res.json();
    $('exit').innerHTML = `<span class="ip">${esc(IP)}</span>${IsTor ? '<span class="badge">IsTor: true</span>' : ''}`;
    $('exit-note').textContent = `That is a Tor exit relay's address, not yours. Websites (and check.torproject.org) see this; the Snowflake server sees only encrypted Tor traffic.`;
  } catch (e) {
    $('exit').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  }
}

// ------------------------------------------------------------------ search
$('search-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  $('go').disabled = true;
  $('results').innerHTML = '<span class="muted">Asking DuckDuckGo over its onion service…</span>';
  const t = performance.now();
  try {
    const { res } = await withDeadline(torFetch(`${DDG}/html/?q=${encodeURIComponent(q)}`), 90_000);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const items = [...doc.querySelectorAll('.result:not(.result--ad)')].map((el) => {
      const a = el.querySelector('a.result__a');
      if (!a) return null;
      let href = a.getAttribute('href') || '';
      const uddg = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg');
      if (uddg) href = uddg;
      return { title: a.textContent.trim(), href, snippet: el.querySelector('.result__snippet')?.textContent.trim() || '' };
    }).filter((x) => x && /^https?:\/\//.test(x.href)).slice(0, 8);
    $('results').innerHTML = `<span class="muted">${items.length} results in ${secs(performance.now() - t)}, fetched from ${DDG.slice(8, 26)}…onion</span>`
      + items.map((it, i) => `<div class="res" data-i="${i}"><b>${esc(it.title)}</b><code>${esc(it.href)}</code><p>${esc(it.snippet)}</p></div>`).join('');
    $('results').querySelectorAll('.res').forEach((el) => el.addEventListener('click', () => openThroughTor(items[+el.dataset.i])));
  } catch (e) {
    $('results').innerHTML = `<span class="muted">Search failed: ${esc(e.message)}</span>`;
  } finally {
    $('go').disabled = false;
  }
});

async function openThroughTor(item) {
  $('viewer-panel').hidden = false;
  $('viewer-title').textContent = `Opening ${item.href} through a Tor exit…`;
  $('viewer').className = 'response empty';
  $('viewer').textContent = 'Building a circuit to an exit relay…';
  $('viewer-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const t = performance.now();
  try {
    const { res, url } = await withDeadline(torFetch(item.href), 90_000);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const seconds = secs(performance.now() - t).replace('s', '');
    $('viewer-title').textContent = `Opened through Tor: ${item.title}`;
    renderResponse($('viewer'), { url, status: res.status, statusText: res.statusText, headers: res.headers, bytes, seconds });
  } catch (e) {
    $('viewer').className = 'response';
    $('viewer').innerHTML = `<span class="rstatus bad">error</span><div class="rbody">${esc(e.message)}</div>`;
  }
}

// ------------------------------------------------------------------ launch
$('launch').addEventListener('click', async () => {
  $('launch').disabled = true;
  launchedAt = performance.now();
  const tick = setInterval(() => { $('clock').textContent = `T+${since()}`; }, 100);
  stage('n-tab', null, 'busy', 'loading…');
  try {
    const { TorClient, Log } = await import('tor-js/wasm-base64');
    stage('n-tab', null, 'on', since());
    client = new TorClient({
      snowflake: true,
      // A directory snapshot hosted with the page (scripts/make-bootstrap.mjs);
      // without it the client downloads the directory over the bridge.
      bootstrapUrl: new URL('bootstrap.zip.zst', location.href).href,
      log: new Log({ rawLog: (level, ...args) => log(level, args.join(' ')) }),
      logLevel: 'info',
    });
    await client.ready();
    once('dir', () => stage('n-dir', 'w2', 'on', since()));
    stage('n-tor', 'w3', 'on', since());
    stage('n-onion', null, 'busy', '');
    $('launch').textContent = `Tor ready in ${since()}`;

    // Everything at once, over the one Snowflake bridge.
    rows[0].start = performance.now();
    const anim = setInterval(renderWaterfall, 100);
    $('q').disabled = $('go').disabled = false;
    showExit();
    await Promise.allSettled(rows.map(loadOnion));
    clearInterval(anim);
    renderWaterfall();
    const ok = rows.filter((r) => !r.error);
    $('clock').textContent = `${ok.length}/${rows.length} onion services loaded, ${kb(ok.reduce((n, r) => n + r.bytes, 0))} in total, all through Tor`;
  } catch (e) {
    log('error', e?.message || String(e));
    $('launch').textContent = 'Failed — see log';
  } finally {
    clearInterval(tick);
  }
});
