# Protecting the server behind an onion service

The site adapter (see the README) lets a static site such as github.io use an onion service as its
dynamic back end. The visitors' pages and scripts come from the static host; only the dynamic
requests go over Tor to your server. This page is about that server: how not to be found, and how
not to be knocked over, without making ordinary visits slower.

What it does not cover: the anonymity of visitors. Their browsers load the page from the static host
directly, so the host sees them; only the requests the adapter routes to the onion service are
anonymised.

## In short

```
node scripts/audit-onion-origin.mjs --origin http://127.0.0.1:8000 --torrc /etc/tor/torrc --paths /,/login
```

checks the points marked "audited" below on the machine that runs the service. For a torrc, use
`torrcLines()` from `scripts/onion-hardening.mjs` (the FlaskBB demo does). The audit cannot see your
firewall or router; test that from another network (below).

## What helps, and what it costs a visitor

| Measure | Cost to a normal visit | Audited | In the FlaskBB demo |
|---|---|---|---|
| Server listens on loopback only (`127.0.0.1`), firewall drops unsolicited inbound traffic | none: Tor and the server are on one machine | yes (and the firewall, from outside) | yes |
| Tor process that listens for nothing and cannot relay, run programs or be debugged (`SocksPort 0`, `ClientOnly`, `NoExec`, `DisableDebuggerAttachment`) | none | yes | yes |
| Introduction-point rate limiting (`HiddenServiceEnableIntroDoSDefense`) and more introduction points (5, Tor's default is 3) | none unless under flood; then excess introductions are dropped at the introduction points | yes | yes |
| No `Server` header, a cap on request body size (10 MiB), a connection limit that fits keep-alive | none | yes (header) | yes |
| Static files from the static host, not the onion service | faster | n/a | yes (the adapter's `static` list) |
| Cache headers on dynamic pages that can be cached | faster | n/a | no |
| Several instances behind OnionBalance | none in the data path (see below) | n/a | no |
| Proof of work (`HiddenServicePoWDefensesEnabled`, queue rate 25, burst 100) | none when not under attack; seconds to minutes of CPU when it asks for effort | yes (limits checked) | yes (`--no-pow` turns it off) |
| A second, private onion service behind a public one | one more Tor leg on every request | n/a | no, not recommended |

### Proof of work

When a service is overloaded, proof of work makes it serve first the visitors who solved a puzzle,
which makes a flood cost the attacker CPU. It is on in the demo, with conservative limits:

    HiddenServicePoWDefensesEnabled 1
    HiddenServicePoWQueueRate 25
    HiddenServicePoWQueueBurst 100

The queue handles at most `Rate` introduction requests a second (bursts up to `Burst`) and raises the
effort it asks for when requests arrive faster than that. Each request is one new visitor connecting,
and every visitor then makes tens of requests to the origin, so 25 a second (some two million new
visitors a day) is far above real traffic and well below what a small origin can serve; Tor's own
defaults, 250 and 2500, assume a big server. Lower numbers engage the defence sooner, which costs
visitors effort sooner. With the service idle it asks for no effort: nothing is solved, no worker is
started, and a visit is as fast as without it (checked in a browser: 0 puzzles, 0 workers).

The browser client solves the puzzles, in Web Workers (see the README, "Onion services that ask for
proof of work"). arti has the solver but runs it on an operating-system thread, which WASM does not
have, so this project vendors a small patch of arti's onion service client (`crates/patches/
tor-hsclient`) that hands the puzzle to JavaScript. What it costs a visitor: the puzzle function
(Equi-X) runs in WASM only through its interpreter, because WASM cannot run generated machine code.
Measured: 310 ms per attempt in WASM, 226 ms natively with the interpreter, 10.8 ms natively with the
compiler that c-tor and arti use. A solution is accepted with probability 1 over the effort and an
attempt yields about 2.4 candidates, so an effort of E costs about E x 0.13 s of one worker. Measured
end to end, from a browser with 8 workers: effort 16 took 3 s; effort 100 took between 6 and 55 s in
seven runs (the first worker to find a solution wins, so times vary widely; a direct test of the
workers on an idle page took 0.5 to 7 s, and why the live runs were slower on average is not
understood); from Node with 3 workers, effort 100 took 9 to 12 s. The client pays at most 2000 by
default (arti's cap is 10000): at these speeds that is minutes, so a visitor facing a very high effort
waits a long time; `client.pow.maxEffort` lowers it. Compiling each puzzle to WASM instead of
interpreting it could make a worker several times faster (an estimate; not built).

Checked against the real Tor program (`test/site-live-pow.mjs`, 0.4.9.11): a solution is accepted and
the page is served; the same solution with one bit of the proof flipped gets no answer within 100 s,
because the service drops a request whose proof does not verify. What was not checked: behaviour under
a real flood (none can be produced here), so that a visitor really is served ahead of one who paid
less, and what effort a real attack makes a service ask for, are by design, not demonstrated.

The workers are run by a page of the site, whichever way the Tor client is hosted (a worker host or the
Service Worker; checked in a browser for both). A visitor with no page open to do it, which in practice
means no visitor, would connect without offering a solution: fine while the service is idle, and at the
back of the queue under attack, as if the service had no proof of work. Turn it off in the demo with `--no-pow`, or in
`torrcLines` with `pow: false`.

### Keep-alive and the server's connection limit

The client keeps a connection for the next request to the same host, for up to 15 s (6 per host at
most). A visitor therefore holds a few idle connections to your server while browsing. A server
that limits connections (Waitress: 100 by default) can be filled by a few dozen visitors; the demo
raises it to 1000. A server whose workers block on an idle connection (Gunicorn's synchronous
workers) answers `Connection: close`, which the client respects, so nothing is held.

### OnionBalance

OnionBalance publishes one descriptor, under the address you advertise, that lists the introduction
points of several instances of the service. A visitor picks an introduction point and then talks to
that instance through the normal onion-service protocol; the OnionBalance machine is not in the data
path, so a request does not take an extra Tor round trip. Each instance needs the same content
(or shared storage) and `HiddenServiceOnionBalanceInstance 1`. It spreads load and avoids one machine
being the whole service. It was not set up or tested for this project.

### After a restart or a configuration change

A restarted service picks new introduction points, but the directory relays that hold its old
descriptor can keep serving it for a while. A visitor who gets the old one reaches introduction points
that no longer know the service (the client logs `NOT_RECOGNIZED`), refetches, and retries; that cost
20 to 90 s in measurements, for a minority of first visits, until the new descriptor has spread.
Restart a service rarely, expect some slow first visits afterwards, and do not read slowness right
after a change as an effect of the change.

## Things that give a server away whatever Tor is configured to do

These are properties of the application and the machine, not of Tor:

- **Software banners.** `Server`, `X-Powered-By` and similar headers let a visitor match your server
  against clearnet ones. Audited.
- **The clock.** Every response carries `Date`. A clock that is off by a distinctive amount can be
  matched with the same machine's responses elsewhere. Keep it synchronised (NTP). Audited (warns on a
  large difference only).
- **Names and addresses in content.** Absolute URLs, email links, error pages, redirects or headers
  that contain the machine's hostname, addresses or any clearnet name it is published under. Audited
  (`--clearnet-host` names the clearnet hosts to look for).
- **Outbound connections by the application** (avatar services, webhooks, mail, update checks, link
  previews) come from the machine's own address. Disable them or send them through Tor. Not audited.
- **The same server on the clearnet.** Shared TLS certificates (public in certificate-transparency
  logs), identical content and matching uptime or outage times tie the two together. Not audited.
- **A reachable origin.** A server that also listens on a public address can be found by scanning,
  and then confirmed by comparing its responses with the onion service's. Audited on the machine; test
  from outside (below).

Never set `HiddenServiceNonAnonymousMode` or `HiddenServiceSingleHopMode`: they make the service
faster by giving up its location.

## Testing from outside

On a machine on another network, with your public address `203.0.113.7` and the server's port 8000:

```
nmap -Pn -p 1-65535 203.0.113.7        # nothing except what you meant to expose
curl -m 5 http://203.0.113.7:8000/     # must not answer
```

and search for your onion service's distinctive text on a clearnet search engine and a Shodan-style
index.

## Measured

The hardened torrc against a minimal one (`SocksPort 0` and the hidden service only), as first-visit
time to a response from a client with cold circuits, 16 samples each, over four new services (two of
each) started together and not touched afterwards:

| | median | slower than 10 s | slower than 15 s |
|---|---|---|---|
| minimal torrc | 6.2 s | 5 of 16 | 2 of 16 (one 72 s) |
| hardened torrc | 7.1 s | 7 of 16 | 4 of 16 (one failure) |

The distributions overlap and the minimal one has the same slow tail (the slow first visits are the
descriptor and introduction retries above, which any service has). Within this sample the hardened
torrc is not distinguishable from the minimal one; a difference of about a second in the typical
first visit cannot be ruled out. Later requests are a normal request to the service either way.
Measuring this needs services that are never restarted between samples; restarting one identity
for each configuration produced differences of 5 to 40 times that were an effect of the restarts.

`.agent/server-hardening-execplan.md` has the whole record.
