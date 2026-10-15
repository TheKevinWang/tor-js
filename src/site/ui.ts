/**
 * Small DOM helpers shared by the loading screen (`loading.ts`) and the connection
 * badge (`badge.ts`).
 *
 * Everything is styled through `element.style` and the Web Animations API rather
 * than a `<style>` element, so a site's strict Content-Security-Policy cannot block it.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const FONT = 'Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
export const MONO = '"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace';
export const ACCENT_GRADIENT = 'linear-gradient(90deg,#9d7bff,#ff79c6)';

/** Create an element with inline styles and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function prefers(query: string): boolean {
  return typeof matchMedia === 'function' && matchMedia(query).matches;
}

export interface Palette {
  bg: string;
  glow: string;
  card: string;
  border: string;
  text: string;
  dim: string;
  muted: string;
  track: string;
  code: string;
  ok: string;
  warn: string;
  err: string;
  shadow: string;
}

/** Colours that follow the visitor's light/dark preference (dark is the tor-js website's own look). */
export function palette(): Palette {
  return prefers('(prefers-color-scheme: light)')
    ? { bg: '#f6f4fb', glow: 'rgba(157,123,255,.22)', card: '#ffffff', border: '#e2dcf2', text: '#1d1830', dim: '#5d5679', muted: '#7d7699', track: '#e4def4', code: '#f1eefb', ok: '#168a55', warn: '#a96a00', err: '#c2324a', shadow: '0 24px 60px -30px rgba(70,50,130,.35)' }
    : { bg: '#0c0a12', glow: 'rgba(157,123,255,.18)', card: 'rgba(23,19,32,.86)', border: '#2c2542', text: '#ece9f6', dim: '#ada7c4', muted: '#8780a4', track: '#2a2342', code: '#110e1a', ok: '#6ee7a8', warn: '#ffd166', err: '#ff6b7d', shadow: '0 24px 70px -30px rgba(0,0,0,.9)' };
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The onion mark of the tor-js website (website/public/onion.svg), built with the DOM. `id` keeps gradient ids unique per instance. */
export function onionMark(id: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', id);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '1');
  grad.setAttribute('y2', '1');
  for (const [offset, color] of [['0', '#b79dff'], ['0.55', '#9d7bff'], ['1', '#ff79c6']] as const) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    grad.append(stop);
  }
  defs.append(grad);
  svg.append(defs);
  const ref = `url(#${id})`;
  const paths: [string, Record<string, string>][] = [
    ['M16 6.5C15.6 3.8 14 2.6 12.2 2.4M16 6.5C16.4 3.8 18 2.6 19.8 2.4', { stroke: ref, 'stroke-width': '2', 'stroke-linecap': 'round' }],
    ['M16 6.2C21 10.2 24.4 14 24.4 19.1c0 5.3-3.7 8.9-8.4 8.9S7.6 24.4 7.6 19.1C7.6 14 11 10.2 16 6.2Z', { stroke: ref, 'stroke-width': '2.2', fill: 'rgba(157,123,255,0.1)', 'stroke-linejoin': 'round' }],
    ['M16 12.2c-2.8 1.6-4.4 4.2-4.4 7 0 3.2 1.9 5.9 4.4 5.9s4.4-2.7 4.4-5.9c0-2.8-1.6-5.4-4.4-7Z', { stroke: ref, 'stroke-width': '1.7', opacity: '0.75' }],
    ['M16 16.4c-1.3 1-2 2.2-2 3.4 0 1.5.9 2.7 2 2.7s2-1.2 2-2.7c0-1.2-.7-2.4-2-3.4Z', { fill: ref }],
  ];
  for (const [d, attrs] of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    svg.append(p);
  }
  return svg;
}

/** What the page says about itself in the connection panels, kept in one place so they agree. */
export const EXPLAINER =
  'This site keeps its server off the public Internet. Requests to the server travel through Tor, a network that relays ' +
  'traffic through several volunteer-run computers, and setting up that route takes a few seconds the first time. ' +
  'Public files, such as this page\'s code and images, load normally so the site stays fast. ' +
  'Tor protects the route to the server; it is not a promise that everything you do is anonymous.';
