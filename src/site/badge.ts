/**
 * A small, persistent connection indicator ("● Private connection") in the corner
 * of the page, for sites that route their private requests through Tor. Click it
 * for what that means in ordinary words, and "Technical details" for what is routed
 * where. It says only what the adapter knows to be true: that requests to the
 * server go through Tor and that public files do not. It does not claim anonymity.
 *
 * It also carries the "transparent" mode's one moment of feedback: when a visitor
 * does something that needs the server before Tor has connected (leaves a comment
 * while the page was still connecting in the background), a notice says that the
 * request is waiting for the private connection and will go through as soon as it
 * is ready.
 *
 * Shown with the loading screen (`data-loading="true"`), in transparent mode
 * (`data-loading="transparent"`) and by the frame shell; `data-badge="false"` on the
 * script tag hides it.
 */

import type { TorSite } from './register.js';
import type { SiteProgress } from './progress.js';
import { EXPLAINER, FONT, el, onionMark, palette } from './ui.js';

/** Below the loading screen (which is 2147483000), above anything a site is likely to use. */
const Z = '2147482000';

export function showConnectionBadge(sitePromise: Promise<TorSite>): { element: HTMLElement } {
  const c = palette();
  const host = location.hostname;

  const root = el('div', `position:fixed;left:12px;bottom:12px;z-index:${Z};font:13px/1.45 ${FONT};color:${c.text}`);

  const pill = el(
    'button',
    `display:flex;align-items:center;gap:7px;padding:6px 12px 6px 9px;border-radius:99px;border:1px solid ${c.border};cursor:pointer;` +
      `background:${c.card};color:${c.text};font:inherit;box-shadow:${c.shadow};backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)`,
  );
  pill.type = 'button';
  pill.setAttribute('aria-haspopup', 'dialog');
  pill.setAttribute('aria-expanded', 'false');
  const dot = el('span', `width:9px;height:9px;border-radius:50%;background:${c.warn};flex:none`);
  const pillText = el('span', '', 'Connecting…');
  pill.append(dot, pillText);

  const panel = el(
    'div',
    `display:none;position:absolute;left:0;bottom:calc(100% + 8px);width:min(340px,calc(100vw - 24px));box-sizing:border-box;padding:16px 16px 12px;` +
      `border-radius:16px;border:1px solid ${c.border};background:${c.card};box-shadow:${c.shadow};backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)`,
  );
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'About this connection');
  const head = el('div', 'display:flex;align-items:center;gap:10px');
  const logo = el('div', 'width:24px;height:24px;flex:none');
  const mark = onionMark('tor-badge-g');
  mark.style.cssText = 'width:100%;height:100%;display:block';
  logo.append(mark);
  const heading = el('strong', 'font-size:1rem', 'Private connection');
  head.append(logo, heading);
  const summary = el('p', `margin:10px 0 0;color:${c.dim}`);
  const checks = el('ul', 'list-style:none;margin:10px 0 0;padding:0');
  const note = el('p', `margin:10px 0 0;color:${c.muted};font-size:.82rem`, EXPLAINER);
  const techToggle = el('button', `margin-top:10px;padding:0;border:0;background:none;color:${c.dim};cursor:pointer;font:inherit;text-decoration:underline;text-underline-offset:3px`, 'Technical details');
  techToggle.type = 'button';
  techToggle.setAttribute('aria-expanded', 'false');
  const tech = el('dl', `display:none;margin:8px 0 0;padding:10px 12px;border-radius:10px;background:${c.code};font-size:.8rem;grid-template-columns:auto 1fr;gap:4px 12px`);
  panel.append(head, summary, checks, note, techToggle, tech);
  const toast = el(
    'div',
    `display:none;position:absolute;left:0;bottom:calc(100% + 8px);width:min(320px,calc(100vw - 24px));box-sizing:border-box;padding:12px 14px;` +
      `border-radius:14px;border:1px solid ${c.border};background:${c.card};box-shadow:${c.shadow};backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)`,
  );
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  const toastTitle = el('strong', 'display:block');
  const toastBody = el('span', `color:${c.dim};font-size:.85rem`);
  toast.append(toastTitle, toastBody);
  root.append(toast, panel, pill);
  document.body.append(root);

  const facts: [string, string][] = [
    ['Transport', 'Tor onion service'],
    ['This site', location.origin],
    ['Private requests', 'Routed through Tor'],
    ['Public files', `Loaded directly from ${host}`],
  ];
  for (const [k, v] of facts) tech.append(el('dt', `color:${c.muted}`, k), el('dd', `margin:0;color:${c.dim};word-break:break-word`, v));

  let progress: SiteProgress = { state: 'idle', percent: 0, phase: 'network', label: '', detail: '' };
  let waiting = 0;
  const renderToast = () => {
    // Held-back requests are counted until their response arrives; the notice is only about Tor connecting.
    const show = waiting > 0 && progress.state !== 'ready' && panel.style.display === 'none';
    toast.style.display = show ? 'block' : 'none';
    if (!show) return;
    const failed = progress.state === 'error';
    toastTitle.textContent = failed ? "Couldn't set up a private connection" : 'Finishing your private connection…';
    toastTitle.style.color = failed ? c.err : c.text;
    toastBody.textContent = failed
      ? 'Your request could not be sent. Reload the page to try again.'
      : `Your request will go through as soon as it is ready${progress.percent > 3 ? ` (${Math.round(progress.percent)}%)` : ''}. This only happens the first time.`;
  };
  const render = () => {
    const ok = progress.state === 'ready';
    const failed = progress.state === 'error';
    dot.style.background = ok ? c.ok : failed ? c.err : c.warn;
    pillText.textContent = ok ? 'Private connection' : failed ? 'Not connected' : 'Connecting…';
    heading.textContent = ok ? 'Private connection' : failed ? 'Not connected' : 'Connecting privately…';
    summary.textContent = ok
      ? 'Your requests to this service are routed through the Tor network.'
      : failed
        ? 'The private connection could not be set up. Reload the page to try again.'
        : 'A private route to the service is being set up.';
    checks.replaceChildren();
    const rows: [boolean, string][] = [
      [ok, ok ? 'Tor network connected' : failed ? 'Tor network not reachable' : 'Connecting to the Tor network'],
      [ok, 'Server address kept off the public Internet'],
    ];
    for (const [good, text] of rows) {
      const li = el('li', `display:flex;gap:8px;color:${good ? c.text : c.muted}`);
      checks.append(li);
      li.append(el('span', `color:${good ? c.ok : c.muted};width:1em;text-align:center;flex:none`, good ? '✓' : '○'), el('span', '', text));
    }
    renderToast();
  };
  render();

  const setOpen = (open: boolean) => {
    pill.setAttribute('aria-expanded', String(open));
    panel.style.display = open ? 'block' : 'none';
    renderToast();
  };
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.style.display === 'none');
  });
  techToggle.addEventListener('click', () => {
    const open = techToggle.getAttribute('aria-expanded') !== 'true';
    techToggle.setAttribute('aria-expanded', String(open));
    tech.style.display = open ? 'grid' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target as Node)) setOpen(false);
  });
  // A click inside the site's iframe never reaches this document, but the window loses focus.
  addEventListener('blur', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  sitePromise.then(
    (s) => {
      progress = s.progress;
      render();
      s.onProgress((p) => {
        progress = p;
        render();
      });
      waiting = s.waiting;
      s.onWaiting((n) => {
        waiting = n;
        renderToast();
      });
      renderToast();
    },
    () => {
      progress = { ...progress, state: 'error' };
      render();
    },
  );

  return { element: root };
}
