/**
 * The loading screen: what a visitor sees while the page connects to Tor, which
 * the first time takes from a few seconds to a minute or more.
 *
 * It has two levels for two audiences. The main view says, in ordinary words,
 * that a private connection to the server is being set up and why it can take a
 * moment, with a route drawn from "you" to "the server" that fills as the real
 * steps complete. One click on "Connection details" shows what is actually
 * happening in Tor's terms: the chain from browser to onion service with each
 * link's state, what travels through Tor and what does not, and the Tor client's
 * own log. A failure is described by where it stopped ("the private network is
 * connected, but the server isn't responding") with the raw error in the details.
 *
 * It is used by the frame shell (`frame.ts`, always) and by a plain page that adds
 * `data-loading="true"` to its script tag.
 */

import type { TorSite } from './register.js';
import { TOR_JOINED_PERCENT, type SiteProgress } from './progress.js';
import { ACCENT_GRADIENT, EXPLAINER, FONT, MONO, el, formatElapsed, onionMark, palette, prefers } from './ui.js';

export interface LoadingScreenOptions {
  /** What the screen is loading, shown under the title. Default: this page's host name. */
  subject?: string;
  /**
   * `"ready"`: remove the screen when Tor is connected (a plain page). `"manual"`: keep it until
   * `dismiss()` is called (the shell removes it when the site's first page has loaded).
   */
  until?: 'ready' | 'manual';
}

export interface LoadingScreen {
  readonly element: HTMLElement;
  /** Show "Connected privately" for a moment, then fade the screen out and remove it. Safe to call more than once. */
  dismiss(): void;
}

/** Elapsed time after which the screen explains that the first connection takes a while. */
const EXPLAIN_AFTER_MS = 6_000;
/** Elapsed time after which it says it is still going and offers to start over. */
const SLOW_AFTER_MS = 40_000;
/** How long "Connected privately" stays before the screen fades. */
const LINGER_MS = 700;

/** The links of the connection from the browser to the onion service, with when each is complete. */
const CHAIN: readonly { name: string; note: string; doneAt: number }[] = [
  { name: 'Browser', note: 'this page', doneAt: 0 },
  { name: 'Web transport', note: 'Snowflake', doneAt: 66 },
  { name: 'Tor network', note: 'guard and relays', doneAt: TOR_JOINED_PERCENT },
  { name: 'Tor circuit', note: 'three hops', doneAt: 94 },
  { name: 'Onion service', note: 'the server', doneAt: Infinity },
];

/**
 * Show the loading screen now and follow `sitePromise` (which resolves once the Service Worker
 * controls the page, so for the first moments there is nothing to report but "starting").
 */
export function showLoadingScreen(sitePromise: Promise<TorSite>, opts: LoadingScreenOptions = {}): LoadingScreen {
  const c = palette();
  const reduceMotion = prefers('(prefers-reduced-motion: reduce)');
  const started = performance.now();
  const until = opts.until ?? 'manual';
  const host = opts.subject ?? location.hostname;

  // --- structure -------------------------------------------------------------

  const overlay = el(
    'div',
    `position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;` +
      `background:radial-gradient(60% 50% at 50% 35%,${c.glow},transparent 70%),${c.bg};color:${c.text};` +
      `font:15px/1.5 ${FONT};transition:opacity .35s ease;color-scheme:${prefers('(prefers-color-scheme: light)') ? 'light' : 'dark'}`,
  );
  const card = el(
    'div',
    `width:100%;max-width:460px;margin:auto;box-sizing:border-box;padding:30px 26px 20px;border-radius:22px;border:1px solid ${c.border};` +
      `background:${c.card};box-shadow:${c.shadow};backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);text-align:center`,
  );

  const logo = el('div', 'width:52px;height:52px;margin:0 auto 14px');
  const mark = onionMark('tor-loading-g');
  mark.style.cssText = 'width:100%;height:100%;display:block';
  logo.append(mark);
  const title = el('h1', 'margin:0;font-size:1.35rem;font-weight:650;letter-spacing:-.01em', 'Connecting securely…');
  const subject = el('p', `margin:4px 0 0;color:${c.dim};font-size:.92rem;word-break:break-all`, host);

  // The route: you ──●──●── server. Each segment fills as its share of the real steps completes.
  const route = el('div', 'display:flex;align-items:center;margin:28px 6px 0');
  route.setAttribute('role', 'progressbar');
  route.setAttribute('aria-valuemin', '0');
  route.setAttribute('aria-valuemax', '100');
  route.setAttribute('aria-label', 'Setting up a private connection');
  const nodes: { dot: HTMLElement; ring: HTMLElement }[] = [];
  const fills: HTMLElement[] = [];
  const makeNode = () => {
    const wrap = el('div', 'position:relative;width:16px;height:16px;flex:none');
    const ring = el('div', `position:absolute;inset:-5px;border-radius:50%;border:2px solid #9d7bff;opacity:0;display:none`);
    const dot = el('div', `position:absolute;inset:0;border-radius:50%;box-sizing:border-box;border:2px solid ${c.track};background:${c.card};transition:background .4s,border-color .4s`);
    wrap.append(ring, dot);
    nodes.push({ dot, ring });
    return wrap;
  };
  for (let i = 0; i < 4; i++) {
    if (i > 0) {
      const seg = el('div', `position:relative;flex:1;height:3px;margin:0 2px;border-radius:2px;background:${c.track};overflow:hidden`);
      const fill = el('div', `position:absolute;inset:0 auto 0 0;width:0;background:${ACCENT_GRADIENT};transition:width .6s cubic-bezier(.22,1,.36,1)`);
      seg.append(fill);
      fills.push(fill);
      route.append(seg);
    }
    route.append(makeNode());
  }
  const ends = el('div', `display:flex;justify-content:space-between;margin:8px 0 0;padding:0 0;color:${c.muted};font-size:.78rem`);
  ends.append(el('span', '', 'You'), el('span', '', 'The server'));

  const stepRow = el('div', 'display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-top:22px;text-align:left');
  const step = el('span', 'font-weight:600');
  step.setAttribute('role', 'status');
  step.setAttribute('aria-live', 'polite');
  const percent = el('span', `color:${c.dim};font-variant-numeric:tabular-nums;font-size:.88rem`);
  stepRow.append(step, percent);
  const hint = el('p', `margin:6px 0 0;min-height:3em;color:${c.dim};font-size:.88rem;text-align:left`);

  const errorBox = el('div', `display:none;margin:14px 0 0;padding:12px 14px;border-radius:12px;border:1px solid ${c.err};text-align:left;font-size:.9rem;color:${c.text}`);
  const errorTitle = el('strong', `display:block;margin-bottom:2px;color:${c.err}`);
  const errorBody = el('span', `color:${c.dim}`);
  errorBox.append(errorTitle, errorBody);
  const retry = el(
    'button',
    `display:none;margin:14px auto 0;padding:9px 22px;border:0;border-radius:99px;cursor:pointer;font:inherit;font-weight:600;color:#fff;background:linear-gradient(120deg,#8a63f0,#d65fb0)`,
    'Try again',
  );
  retry.type = 'button';
  retry.addEventListener('click', () => location.reload());

  // "Powered by Tor ⓘ" and its explanation.
  const torRow = el('div', `margin-top:18px;color:${c.muted};font-size:.82rem`);
  const torToggle = el('button', `padding:2px 4px;border:0;background:none;color:${c.dim};cursor:pointer;font:inherit;border-radius:6px`, 'Powered by Tor ⓘ');
  torToggle.type = 'button';
  torToggle.setAttribute('aria-expanded', 'false');
  torToggle.setAttribute('aria-label', 'Powered by Tor. What does that mean?');
  torRow.append(torToggle);
  const explainer = el('p', `display:none;margin:8px 0 0;padding:10px 12px;border-radius:10px;background:${c.code};color:${c.dim};font-size:.82rem;text-align:left`, EXPLAINER);

  const footer = el('div', `display:flex;justify-content:space-between;align-items:center;margin-top:16px;padding-top:12px;border-top:1px solid ${c.border};color:${c.muted};font-size:.8rem`);
  const elapsed = el('span', 'font-variant-numeric:tabular-nums', 'Elapsed 0s');
  const detailsToggle = el('button', `padding:2px 0;border:0;background:none;color:${c.dim};cursor:pointer;font:inherit`, 'Connection details ▾');
  detailsToggle.type = 'button';
  detailsToggle.setAttribute('aria-expanded', 'false');
  footer.append(elapsed, detailsToggle);

  const details = el('div', 'display:none;margin-top:12px;text-align:left');
  const chainList = el('ol', 'list-style:none;margin:0;padding:0');
  const facts = el('dl', `margin:12px 0 0;padding:10px 12px;border-radius:10px;background:${c.code};font-size:.8rem;display:grid;grid-template-columns:auto 1fr;gap:4px 14px`);
  const log = el('pre', `margin:10px 0 0;padding:10px 12px;max-height:130px;overflow:auto;border-radius:10px;background:${c.code};color:${c.dim};font:11px/1.5 ${MONO};white-space:pre-wrap;word-break:break-word`);
  details.append(chainList, facts, log);

  card.append(logo, title, subject, route, ends, stepRow, hint, errorBox, retry, torRow, explainer, footer, details);
  overlay.append(card);
  document.body.append(overlay);

  // --- motion (stops for reduced motion) -------------------------------------

  const animations: Animation[] = [];
  const canAnimate = !reduceMotion && typeof logo.animate === 'function';
  if (canAnimate) {
    animations.push(logo.animate([{ transform: 'scale(1)', opacity: 0.85 }, { transform: 'scale(1.07)', opacity: 1 }], { duration: 1800, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }));
    for (const n of nodes) {
      animations.push(n.ring.animate([{ transform: 'scale(.7)', opacity: 0.8 }, { transform: 'scale(1.25)', opacity: 0 }], { duration: 1500, iterations: Infinity, easing: 'ease-out' }));
    }
  }

  // --- rendering --------------------------------------------------------------

  let site: TorSite | null = null;
  let progress: SiteProgress = { state: 'idle', percent: 3, phase: 'network', label: 'Starting the private network', detail: 'Starting' };
  let finished = false; // the server answered: show "Connected privately"
  let dismissed = false;

  const detailsOpen = () => detailsToggle.getAttribute('aria-expanded') === 'true';

  /** Where the route graphic and the chain stand: 96 while only the server is left, 100 once it has answered. */
  const routePercent = () => (finished ? 100 : progress.state === 'ready' ? 96 : progress.percent);

  const renderRoute = () => {
    const p = routePercent() / 100;
    fills.forEach((f, i) => {
      f.style.width = `${Math.round(Math.min(1, Math.max(0, p * 3 - i)) * 100)}%`;
      f.style.background = progress.state === 'error' ? c.err : ACCENT_GRADIENT;
    });
    const lit = (i: number) => i === 0 || (i === 3 ? finished : p * 3 >= i);
    const firstOpen = nodes.findIndex((_, i) => !lit(i));
    nodes.forEach((n, i) => {
      const failedHere = progress.state === 'error' && i === firstOpen;
      n.dot.style.background = failedHere ? c.err : lit(i) ? '#9d7bff' : c.card;
      n.dot.style.borderColor = failedHere ? c.err : lit(i) ? '#9d7bff' : c.track;
      n.ring.style.display = i === firstOpen && progress.state !== 'error' && !finished ? 'block' : 'none';
    });
    route.setAttribute('aria-valuenow', String(Math.round(routePercent())));
  };

  const renderDetails = () => {
    const pct = routePercent();
    const failed = progress.state === 'error';
    chainList.replaceChildren();
    let activeSeen = false;
    for (const link of CHAIN) {
      const done = link.doneAt === Infinity ? finished : pct >= link.doneAt;
      const active = !done && !activeSeen;
      if (!done) activeSeen = true;
      const li = el('li', `display:flex;gap:10px;align-items:baseline;padding:3px 0;font-size:.85rem;color:${done ? c.text : c.muted}`);
      const mark = done ? '✓' : active ? (failed ? '✕' : '●') : '○';
      const markColor = done ? c.ok : active ? (failed ? c.err : c.warn) : c.muted;
      li.append(el('span', `width:1em;flex:none;text-align:center;color:${markColor}`, mark), el('span', 'font-weight:550', link.name), el('span', `color:${c.muted};font-size:.78rem`, link.note));
      chainList.append(li);
    }
    const rows: [string, string][] = [
      ['Transport', 'Tor (onion service)'],
      ['Private requests', 'Routed through Tor'],
      ['Public files', `Loaded directly from ${host}`],
      ['Current step', progress.detail],
    ];
    if (failed) rows.push(['Error', progress.message ?? 'unknown error']);
    facts.replaceChildren();
    for (const [k, v] of rows) facts.append(el('dt', `color:${c.muted}`, k), el('dd', `margin:0;color:${c.dim};word-break:break-word`, v));
    const lines = (site?.timeline ?? []).slice(-40).map((e) => `${(e.t / 1000).toFixed(1).padStart(6)}s  ${e.text}`);
    log.textContent = lines.length ? lines.join('\n') : 'Nothing reported from the Tor client yet.';
    log.scrollTop = log.scrollHeight;
  };

  const render = () => {
    const failed = progress.state === 'error';
    const torUp = progress.percent >= TOR_JOINED_PERCENT;
    title.textContent = failed ? (torUp ? "Couldn't reach the server" : "Couldn't set up a private connection") : finished ? 'Connected privately' : 'Connecting securely…';
    step.textContent = failed ? '' : finished ? 'Ready' : progress.label;
    percent.textContent = failed || finished ? '' : `${Math.round(routePercent())}%`;
    errorBox.style.display = failed ? 'block' : 'none';
    errorTitle.textContent = failed ? (torUp ? 'The private network is connected, but the server isn\'t responding.' : 'Your browser couldn\'t reach the Tor network.') : '';
    errorBody.textContent = failed
      ? torUp
        ? 'The server may be busy or offline. Trying again usually helps.'
        : 'Some networks block or slow it down. Try again, or try a different network.'
      : '';
    retry.style.display = failed ? 'block' : 'none';
    renderRoute();
    for (const a of animations) failed || finished ? a.pause() : a.play();
    renderHint();
    if (detailsOpen()) renderDetails();
  };

  const renderHint = () => {
    const ms = performance.now() - started;
    if (progress.state === 'error') hint.textContent = '';
    else if (finished) hint.textContent = '';
    else if (ms > SLOW_AFTER_MS) hint.textContent = 'Still connecting… Some networks make private connections slower. You can keep waiting or start over.';
    else if (ms > EXPLAIN_AFTER_MS) hint.textContent = 'The first connection may take a little longer while a private route is established.';
    else hint.textContent = 'Establishing a private connection to the service.';
    hint.style.display = hint.textContent ? 'block' : 'none';
    // After a long wait, offer to start over without hiding that it is still working.
    if (progress.state !== 'error' && !finished) {
      const slow = ms > SLOW_AFTER_MS;
      retry.style.display = slow ? 'block' : 'none';
      retry.textContent = 'Start over';
    } else {
      retry.textContent = 'Try again';
    }
  };

  const toggles = () => {
    const open = (b: HTMLElement) => b.getAttribute('aria-expanded') === 'true';
    detailsToggle.addEventListener('click', () => {
      const next = !open(detailsToggle);
      detailsToggle.setAttribute('aria-expanded', String(next));
      detailsToggle.textContent = next ? 'Connection details ▴' : 'Connection details ▾';
      details.style.display = next ? 'block' : 'none';
      if (next) renderDetails();
    });
    torToggle.addEventListener('click', () => {
      const next = !open(torToggle);
      torToggle.setAttribute('aria-expanded', String(next));
      explainer.style.display = next ? 'block' : 'none';
    });
  };
  toggles();

  const tick = setInterval(() => {
    elapsed.textContent = `Elapsed ${formatElapsed(performance.now() - started)}`;
    renderHint();
    if (detailsOpen()) renderDetails();
  }, 1000);

  const onProgress = (p: SiteProgress) => {
    if (dismissed) return;
    progress = p;
    render();
    if (p.state === 'ready' && until === 'ready') dismiss();
  };

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearInterval(tick);
    // The first page can be an error page from a failed attempt; only a good connection says "Connected privately".
    const ok = progress.state !== 'error';
    finished = ok;
    render();
    // Let the last link light up and read "Connected privately" before the screen goes.
    setTimeout(() => {
      for (const a of animations) a.cancel();
      overlay.style.opacity = '0';
      overlay.style.pointerEvents = 'none';
      setTimeout(() => overlay.remove(), 400);
    }, !ok ? 0 : reduceMotion ? 200 : LINGER_MS);
  };

  render();
  sitePromise.then(
    (s) => {
      site = s;
      onProgress(s.progress);
      s.onProgress(onProgress);
    },
    (e) => onProgress({ ...progress, state: 'error', message: e instanceof Error ? e.message : String(e) }),
  );

  return { element: overlay, dismiss };
}
