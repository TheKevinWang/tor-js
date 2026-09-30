// This file is the site's own code. It contains no Tor code: only relative-URL
// fetch() calls, exactly what a site written for an ordinary backend would do.
// The only Tor-aware line is `await window.torSite`, which waits until the
// Service Worker is in control (needed once, on the very first visit).

const $ = (id) => document.getElementById(id);

const site = await window.torSite;

function showStatus(s) {
  $('dot').dataset.state = s.state;
  $('status-text').textContent =
    s.state === 'ready' ? 'Connected to Tor'
    : s.state === 'error' ? `Tor failed: ${s.message}`
    : s.state === 'bootstrapping' ? 'Connecting to Tor (first time takes a few seconds)…'
    : 'Waiting…';
  $('run').disabled = s.state === 'error';
}
showStatus(site.status);
site.onStatus(showStatus);

async function timed(path) {
  const t0 = performance.now();
  const res = await fetch(path);
  const buf = await res.arrayBuffer();
  const via = res.headers.get('x-tor-site') === 'tor' ? 'Tor (onion service)' : 'static host';
  const row = document.createElement('tr');
  for (const cell of [path, via, String(res.status), String(buf.byteLength), `${Math.round(performance.now() - t0)} ms`]) {
    const td = document.createElement('td');
    td.textContent = cell;
    row.append(td);
  }
  $('log').tBodies[0].append(row);
  return new TextDecoder().decode(buf);
}

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  $('log').tBodies[0].replaceChildren();
  try {
    await timed('style.css'); // not in the manifest: the static host answers
    const robots = await timed('duck/robots.txt'); // routed to Tor
    await timed('duck/html/?q=static+sites'); // a whole HTML document, routed to Tor
    $('preview').hidden = false;
    $('preview').textContent = `duck/robots.txt from the onion service:\n\n${robots}`;
  } finally {
    $('run').disabled = false;
  }
});
