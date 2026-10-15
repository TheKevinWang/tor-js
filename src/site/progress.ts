/**
 * How far along connecting to Tor is, worked out from what the Tor client says.
 *
 * The client reports a coarse state (`idle`, `bootstrapping`, `ready`, `error`) and,
 * in its log, a sequence of milestones. This maps the milestones to an estimated
 * percentage, a plain-language step for everybody (`label`) and the technical
 * step for those who want it (`detail`), for the loading screen (`loading.ts`).
 * It is an estimate: the real time between two milestones varies from under a
 * second to a minute (a WebRTC volunteer proxy), so the number only ever moves
 * forward and says nothing about time left.
 */

import type { SiteStatus } from './backend.js';

/** The three stretches of the route, in order. */
export type SitePhase = 'network' | 'route' | 'server';

export interface SiteProgress {
  /** The coarse state of the connection. */
  state: SiteStatus['state'];
  /** Estimated progress, 0 to 100. Never decreases within one attempt. */
  percent: number;
  /** Which stretch is under way. */
  phase: SitePhase;
  /** What is happening now, in plain words. */
  label: string;
  /** The same step in Tor's terms, for the technical view. */
  detail: string;
  /** Set when `state` is "error". */
  message?: string;
}

/** From this progress on, the Tor network itself has been joined (only the server is left). */
export const TOR_JOINED_PERCENT = 84;

const PHASE_LABEL: Record<SitePhase, string> = {
  network: 'Starting the private network',
  route: 'Finding a route',
  server: 'Connecting to the server',
};

interface Milestone {
  /** Matched against a log line. */
  pattern: RegExp;
  percent: number;
  phase: SitePhase;
  detail: string;
}

/**
 * In the order they normally happen. The patterns are the Tor client's own log
 * lines (`crates/tor-js-wasm/src/lib.rs`, `fast_bootstrap.rs`, `snowflake/*.rs`
 * and `src/TorClient.ts`); one that stops matching only makes the bar jump over it.
 */
const MILESTONES: readonly Milestone[] = [
  { pattern: /Creating TorClient/, percent: 12, phase: 'network', detail: 'Starting the Tor client' },
  { pattern: /Snowflake: opening a session/, percent: 18, phase: 'network', detail: 'Looking for a Snowflake proxy' },
  { pattern: /Snowflake: asking the broker/, percent: 24, phase: 'network', detail: 'Asking the Snowflake broker for a volunteer proxy' },
  { pattern: /Initializing JS storage/, percent: 30, phase: 'network', detail: 'Reading saved Tor state' },
  { pattern: /Fast bootstrap: fetching/, percent: 36, phase: 'network', detail: 'Downloading the Tor network directory' },
  { pattern: /Fast bootstrap: received/, percent: 44, phase: 'network', detail: 'Unpacking the Tor network directory' },
  { pattern: /Fast bootstrap: (done|storage already has a fresh)/, percent: 50, phase: 'network', detail: 'Tor network directory ready' },
  { pattern: /Storage configured/, percent: 54, phase: 'network', detail: 'Tor network directory ready' },
  { pattern: /data channel to a volunteer proxy is open/, percent: 62, phase: 'network', detail: 'Connected to a Snowflake volunteer proxy' },
  { pattern: /Snowflake: (ready after|using a session opened earlier)/, percent: 66, phase: 'network', detail: 'Snowflake connection ready' },
  { pattern: /Bootstrapping Tor client/, percent: 72, phase: 'route', detail: 'Bootstrapping the Tor client' },
  { pattern: /guard .* is usable/, percent: 78, phase: 'route', detail: 'Connected to a Tor entry guard' },
  { pattern: /Bootstrap complete/, percent: TOR_JOINED_PERCENT, phase: 'route', detail: 'Tor network joined' },
  { pattern: /First circuit through the bridge/, percent: 94, phase: 'route', detail: 'First Tor circuit built' },
];

const STARTING: SiteProgress = { state: 'idle', percent: 3, phase: 'network', label: PHASE_LABEL.network, detail: 'Starting' };

/** Follows a connection attempt; feed it the Tor client's log lines and state changes. */
export class ProgressTracker {
  private current: SiteProgress = STARTING;

  get progress(): SiteProgress {
    return this.current;
  }

  /** A log line from the Tor client. Returns true if the progress changed. */
  log(message: string): boolean {
    // Once the attempt is over only a new one (a "bootstrapping" status) moves the bar.
    if (this.current.state === 'ready' || this.current.state === 'error') return false;
    let best: Milestone | null = null;
    for (const m of MILESTONES) {
      if (m.pattern.test(message) && m.percent > this.current.percent && (!best || m.percent > best.percent)) best = m;
    }
    if (!best) return false;
    this.current = { ...this.current, percent: best.percent, phase: best.phase, label: PHASE_LABEL[best.phase], detail: best.detail };
    return true;
  }

  /** A state change. Returns true if the progress changed. */
  status(status: SiteStatus): boolean {
    const was = this.current;
    switch (status.state) {
      case 'bootstrapping':
        // A new attempt after a failure starts again from the beginning.
        this.current =
          was.state === 'error' || was.state === 'ready'
            ? { state: 'bootstrapping', percent: 8, phase: 'network', label: PHASE_LABEL.network, detail: 'Starting the Tor client' }
            : { ...was, state: 'bootstrapping', percent: Math.max(was.percent, 8), detail: was.percent > 8 ? was.detail : 'Starting the Tor client' };
        break;
      case 'ready':
        this.current = { state: 'ready', percent: 100, phase: 'server', label: PHASE_LABEL.server, detail: 'Tor connected' };
        break;
      case 'error':
        this.current = { ...was, state: 'error', message: status.message ?? 'unknown error' };
        break;
      case 'idle':
        return false;
    }
    const now = this.current;
    return now.state !== was.state || now.percent !== was.percent || now.label !== was.label || now.detail !== was.detail || now.message !== was.message;
  }
}
