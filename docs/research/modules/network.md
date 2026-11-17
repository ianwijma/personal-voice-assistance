# Network

Research write-up, 2026-11-18. Not an approved design. Shared foundations are named as in [`README.md`](README.md) and
linked, not redesigned. Outside facts carry a link; **[unverified]** marks what I could not confirm against a primary
source. Nothing on the owner's network was contacted. Latency figures are targets to be measured with `TurnTrace`.

## 1. Summary

The home network by voice: what is online and what is new, the guest Wi-Fi password and its QR code on a screen,
pausing a child's device for dinner, switching the ad blocker off for five minutes, a speed test, and above all a
**spoken explanation when the internet is down** ("the router is fine, the line to the provider is down since 14:02").
One module with an adapter per router or controller (UniFi, OpenWrt, Fritz!Box, OPNsense), per DNS filter (Pi-hole,
AdGuard Home) and per VPN (Tailscale, WireGuard).

- **Boundary.** [smart-home](smart-home.md) owns *people's* presence from Home Assistant; this module knows *devices*
  on the network and offers that as a presence hint, never as "who is home". [core-tools](core-tools.md)
  `system_status` has an internet probe for the server's own health; this module owns the diagnosis and the outage
  announcement, and core-tools should read it. [homelab](homelab.md) owns servers and containers, including the
  container that runs Pi-hole; this module owns what Pi-hole *does*. [computer-control](computer-control.md) owns
  Wake-on-LAN.
- **Priority: second wave**; the internet-down explanation and guest Wi-Fi QR are cheap and could ship in the first.
- **Effort: M** for one router adapter, one DNS filter, Tailscale, the outage detector and the guest QR; each extra
  router adapter is S–M.

## 2. What others do

| Who | What | Copy | Avoid |
|---|---|---|---|
| Google Home / Nest Wifi, Eero, Alexa with Eero | "Pause the kids' Wi-Fi", "what's the guest Wi-Fi password" with a card, device groups per person, scheduled pauses | Groups per person ("Emma's devices"), the guest card, pause with an end time | A cloud account between the house and its router |
| [UniFi Network Integration API](https://developer.ui.com/unifi-api/gettingstarted) | Local API with `X-API-Key`; clients, devices, `AUTHORIZE_GUEST_ACCESS` with time and data limits ([help](https://help.ui.com/hc/en-us/articles/31228198640023)) | The official local API over the legacy cookie API | Legacy `/api/s/{site}/cmd/stamgr` endpoints unless the new API lacks a verb |
| [NetAlertX](https://github.com/netalertx/NetAlertX) (formerly Pi.Alert) | New-device alerts from ARP scans, Pi-hole and DHCP lease imports, UniFi import; Apprise | Use its detection instead of our own scanner; ARP only sees the local subnet | A second alert channel next to ours |
| [Speedtest Tracker](https://docs.speedtest-tracker.dev/api/v1) | Scheduled speed tests, `GET /api/v1/results/latest` with a `results:read` token | Read the last scheduled result instead of running a test on demand | Running a heavy test on the household line each time someone asks |
| Pi-hole, AdGuard Home apps and HA integrations | "Disable for 5 minutes" buttons | The timed disable, always with an end | Permanent disable by voice |
| Fritz!Box app | Parental-control tickets, block internet per device via TR-064 `X_AVM-DE_HostFilter` ([AVM interfaces](https://fritz.com/en-at/pages/interfaces)) | Typed, vendor-documented verbs | — |

## 3. Example conversations

1. "Hey Jeff, what's the guest Wi-Fi password?" (kitchen screen) → "It's on the screen: scan the code, or the password is *sunflower-river-42*." Screen: `handoff`-style QR with `WIFI:T:WPA;S:Casa-Guest;P:…;;`. **Screen preferred.**
2. Same question on the hallway node (public) → "I can show it on the kitchen screen, or send it to your phone."
3. "Pause Emma's iPad until dinner's over." → "Pause internet for Emma's iPad until 19:00?" → "Yes." → "Paused until seven."
4. "Turn the ad blocker off for five minutes." → `net_dns_filter { enabled: false, for: "5m" }` → "Ad blocking is off until 14:37."
5. "Is the internet down?" → "Yes, since 14:02. The router and Wi-Fi are fine; the router has no connection to the provider. It's not just one site: Cloudflare and Google both fail." (fast path, no hosted model; §12)
6. "How fast is the internet?" → "This morning's test: 940 down, 48 up, 9 milliseconds. Want a fresh test? It uses the line for about 20 seconds."
7. "What's new on the network?" → "Two new devices this week: an Espressif chip on Tuesday, probably a smart plug, and a phone called *Pixel-8* on Thursday." (screen: `table`)
8. "Is my laptop on the VPN?" → "Yes, your laptop is connected to the tailnet, last seen a minute ago, via the Amsterdam relay."
9. **Ambiguous:** "Pause the TV." → "The living-room TV or the Chromecast in the bedroom?"
10. **Failure:** "Unpause Emma's iPad." → "I couldn't reach the Fritz!Box. If it's restarting, try again in a minute."

## 4. Tools

Risk classes are [§B.5](../module-investigation/module-definition-config-and-dependencies.md#b5-risky-tools)'s;
template equivalent in brackets.

| Tool | Parameters | Returns | R/W | Risk | Latency (target) | Fast path |
|---|---|---|---|---|---|---|
| `net_status` | — | internet up/down and since when, which layer failed (§5.2), router, Wi-Fi, DNS filter, VPN | R | read (safe) | < 100 ms (cached); fresh probe ≤ 2 s | **yes, must work offline** |
| `net_clients` | `filter?: online \| new \| person \| name`, `since?` | devices: name, owner group, vendor, IP, first and last seen, wired/wireless, AP | R | read (personal) | 0.2–1 s | yes |
| `net_guest_wifi` | `show?: device` | SSID, password, QR presentation; with UniFi, optionally authorise a waiting guest | R | read (security-adjacent: a secret) | < 100 ms (from the vault) | yes |
| `net_pause` | `who: device \| group`, `until?: time \| duration`, `off?: boolean` | paused until, by which mechanism | W | change (confirm) | 0.3–2 s | yes |
| `net_dns_filter` | `enabled: boolean`, `for?: duration` (required when disabling, ≤ 60 min), `client?` | state and end time | W | change | 0.2–1 s | yes |
| `net_speedtest` | `fresh?: boolean` | down, up, ping, jitter, when, server | R (fresh: W, uses the line) | read; fresh = change | cached < 100 ms; fresh 20–40 s as a task | yes for cached |
| `net_vpn` | `device?` | Tailscale peers (online, last seen, relay or direct, exit node), WireGuard peers (latest handshake) | R | read | 0.2–1 s | yes |
| `net_name_device` | `device`, `name`, `group?` | done | W | change | < 100 ms (our store) | no |
| `net_block_device` | `device`, `until?` | blocked | W | **security** (it can lock out a person or the server itself) | 0.3–2 s | no |

Not offered: changing the Wi-Fi password, firewall or port-forward rules, router reboots, firmware updates, DNS
records, VPN key or ACL changes, port scans of the LAN on request.

## 5. Integrate or build

### 5.1 Adapters

| System | API | Verbs we need | Notes |
|---|---|---|---|
| UniFi (Network app 9+) | Official local API, `X-API-Key`, `/v1/sites/{siteId}/clients`, `…/clients/{id}/actions` | clients, guest authorise; block/unblock **[unverified in the new API; legacy `block-sta` exists]**; WLAN passphrase read | Key inherits the creating user's role; make a dedicated limited admin |
| OpenWrt | ubus JSON-RPC over HTTP at `/ubus` (`uhttpd-mod-ubus`), `session.login`, rpcd ACLs in `/usr/share/rpcd/acl.d/` ([ubus docs](https://openwrt.org/docs/techref/ubus)) | DHCP leases (`luci-rpc getDHCPLeases` **[unverified]**), wireless clients (`hostapd.*` `get_clients`), firewall rule toggle via `uci` for pause | Write a narrow ACL role: read objects plus one `uci` section; wildcards do not cover child objects |
| Fritz!Box | TR-064 SOAP on port 49000/49443, digest auth; `X_AVM-DE_HostFilter` `DisallowWANAccessByIP` with `NewDisallow` 1/0 ([SCPD](https://fritz.com/fileadmin/user_upload/Global/Service/Schnittstellen/x_hostfilterSCPD.pdf)); `Hosts` for clients; WLAN guest via `WLANConfiguration:3` **[unverified index]** | clients, pause, guest Wi-Fi state | Dedicated FRITZ!Box user with "FRITZ!Box settings" right; no Node library of note, SOAP is small |
| OPNsense | REST with key and secret (basic auth), `/api/dhcpv4/leases/searchLease` or Kea endpoints, `/api/firewall/alias/…` | leases, ARP, pause by adding the IP to an alias referenced by a block rule, then `reconfigure` | Pause-by-alias is the clean pattern: one rule, many devices **[unverified exact toggle route]** |
| Pi-hole v6 | REST: `POST /api/auth` → `sid` (1,800 s), then `POST /api/dns/blocking { blocking: false, timer: 300 }` ([auth docs](https://docs.pi-hole.net/api/auth/)) | timed disable; per-client groups for pause | Use an app password; v6 is session-based, no static token; avoid parallel calls |
| AdGuard Home | REST with basic auth: `POST /control/protection { enabled, duration }` (ms); `/control/clients/update` with `blocked_services` and `blocked_services_schedule` ([changelog](https://git.sadium.cyou/mirrors/AdGuardHome/src/tag/v0.107.53/openapi/CHANGELOG.md)) | timed disable; per-client pause by blocking all services **[unverified that "all" exists]** | A DNS-level pause is bypassable (hard-coded DNS, DoH); router-level is the real pause |
| Tailscale | `GET https://api.tailscale.com/api/v2/tailnet/{tailnet}/devices` with an OAuth client scoped to devices read ([OAuth clients](https://tailscale.com/kb/1215/oauth-clients)); or `tailscale status --json` on the server | peers, last seen, exit node | The local CLI needs no cloud token; the API sees devices the server's node cannot |
| WireGuard | `wg show all dump` (needs `CAP_NET_ADMIN`) on the host running it, via the [homelab](homelab.md) SSH wrapper | latest handshake per peer | |
| NetAlertX | its API or webhook publisher **[unverified endpoints]** | new devices | Preferred source for "new device" when present |
| Speedtest Tracker | `GET /api/v1/results/latest`, bearer, `results:read` | last result | Fresh tests: its "run" endpoint **[unverified]**, else `librespeed-cli`; Ookla's CLI licence forbids much non-personal use **[unverified]** |

### 5.2 Internet-down detection (build)

A fiber on the server probes every 30 s, escalating to every 5 s after a failure, in layers so it can *explain*:

1. Our own LAN link (interface up, default route present).
2. The gateway (ICMP or TCP to the router's admin port).
3. The router's own WAN state from its adapter (UniFi WAN health, Fritz `WANCommonInterfaceConfig` link status,
   OPNsense gateway status) — the best evidence, when available.
4. Public DNS by IP (`1.1.1.1`, `9.9.9.9` on 53/TCP) — tells "DNS filter broken" apart from "internet down".
5. Two HTTPS endpoints (`https://www.google.com/generate_204`, `https://cloudflare.com/cdn-cgi/trace`).
6. Our hosted model provider's endpoint — tells "the assistant's brain is unreachable" apart from the rest.

The verdict (`ok | lan | router | wan | dns | partial | provider`) and `since` are cached; transitions emit events.
**Recommendation:** build this (it is small and central), integrate everything else through adapters, and prefer
NetAlertX and Speedtest Tracker when the owner runs them over our own scanning and testing.

### 5.3 MCP servers instead?

UniFi, OPNsense, Pi-hole and AdGuard MCP servers exist in directories **[unverified quality]**. They expose firewall and
DHCP writes the voice path must not have, have no outage detector, and cannot run offline, which is exactly when this
module matters. Native is right here; MCP via [mcp-client](mcp-client.md) only for read-only exploration.

## 6. Data

| What | Scope | Schema | Read by others |
|---|---|---|---|
| Device registry | household | `{ mac, name, group?, owner?: Person, vendor, firstSeen, lastSeen, kind?: phone \| tv \| iot \| computer \| server, protected? }` | presence hint for smart-home and reminders; homelab (server IPs) |
| Groups | household | `{ id: "emma", spoken: ["Emma's devices"], members: mac[] }` | — |
| Pauses | household | `{ target, mechanism, until, setBy: Actor, jobId }` | lists (kids' chores tie-in, later) |
| Guest Wi-Fi | vault | `{ ssid, password, security }`, read from the router when the adapter can, else typed by the owner | — |
| Outage log | household | `{ verdict, from, to?, evidence }`, 90 days | briefing, homelab |
| Speed results | household (cache) | from Speedtest Tracker or our own tests | briefing |

## 7. Long-running work and events

- **Pauses** end with a [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler)
  one-shot job; missed while down → unpause at start (failing safe toward connectivity) and say so in the inbox.
  Timed DNS-filter disables use the filter's own timer *and* a job, so a crash never leaves blocking off.
- **Fresh speed test** is a `task` (20–40 s) that reports on the origin device.
- **Events:** `network.internet.down`, `.up` (with duration), `network.device.new`, `network.vpn.peer.offline`,
  `network.pause.ended`. Homelab listens to `internet.down` to suppress external-monitor alerts.

## 8. Presentation

Guest Wi-Fi: a large QR in the standard `WIFI:` format plus SSID and password in big type; the character steps aside
(Orbit layout) and the card lingers for 2 minutes. Clients and new devices: `table`. Outage: `facts` with the layer
diagram as a short checklist ("LAN ✓ Router ✓ Provider ✗"). Speed: `facts`, or a `chart` of the last week. VPN: `list`.
Without a screen: the password is read **slowly, in words, once**, only on private devices (§13); tables become counts.

## 9. Notifications and proactive behaviour

| What | Priority | Where |
|---|---|---|
| Internet down > 2 min | `normal`, spoken once, from local TTS (§12) | owner devices; shared rooms one short line |
| Internet back | `low`, with duration | inbox; spoken only if the down notice was spoken and not acknowledged |
| New unknown device | `low`; `normal` if the owner turned on "alert on new devices" | inbox, owner |
| Pause ended | none | — |
| VPN peer (a remote site) offline > 15 min | `low` | inbox |

During an outage, the phone channels that need the internet (ntfy relays, HA cloud push) fail; local devices still speak.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | groups per person; announce outages in shared rooms; alert on new devices | none; on (one line); off |
| Module | router adapter, DNS filter, VPN, NetAlertX and Speedtest Tracker URLs; probe targets; max DNS-filter disable (60 min); default pause length (1 h) | none; as §5.2 |
| Assistant | which assistants: main (status, guest Wi-Fi, filter), Admin (all) | main: status and guest only |
| Device | may show the guest password; `allowRisky` | on for `shared` screens, off for `public`; off |
| Person | "my devices" | — |

**First run:** pick the router type, create a limited user or key on it, paste in admin, **Test** lists clients; the
owner names and groups the important devices (the admin shows unknown ones with vendor from the MAC prefix); enter or
import the guest Wi-Fi; optionally add Pi-hole/AdGuard, Tailscale, NetAlertX, Speedtest Tracker.

## 11. Native tools and dependencies

| Dependency | Where | Missing → spoken |
|---|---|---|
| Router or controller reachable | LAN | "I can't reach the router, so I can't see devices." Outage detection still runs layers 1, 2, 4–6 |
| `qrcode` (npm, pure JS) | server | bundled |
| `tailscale` CLI | server (if it is on the tailnet) | Tailscale via API only, or "VPN status isn't set up." |
| `librespeed-cli` | server, optional | "I can only tell you the last scheduled test." |
| `CAP_NET_RAW` for ICMP | server | TCP probes instead; no message |

## 12. Interaction with the rest of the system

- **Offline first.** When the internet is down, the hosted model is down too. "Is the internet down?" and the outage
  announcement therefore run on the fast path (typed action, canned sentence templates filled from the verdict) and
  local TTS. This is the one module where the fast path is not an optimisation but the only path.
- **Voice.** Device names are owner-given; MAC addresses and IPs are never spoken. Durations as "since 14:02, about
  twenty minutes". The password is spelled with a phonetic option on request ("S as in sugar").
- **Agents.** The main assistant gets status, guest Wi-Fi and the filter toggle; the Admin template from
  [homelab](homelab.md#12-interaction-with-the-rest-of-the-system) gets everything; a kids' assistant gets status only.
- **Other modules.** [smart-home](smart-home.md) may read `network.device` online state as a presence hint;
  [briefing](briefing.md) reads overnight outages and the speed trend; [routines](routines-and-automations.md) can
  pause a group as a step ("dinner time": lights, music off, pause the kids' devices).

## 13. Privacy and safety

- **Who is online is surveillance.** A device list reveals who is home and when. Client lists are `personal`: owner's
  trusted devices only; `shared` devices get counts; `public` get "the network is fine". Never "Emma's phone left at
  23:40" to anyone but the owner, and household members should know the feature exists (open question 4).
- **Pausing a person's device** is `change` with confirmation, limited to groups the owner created, always with an end
  time (default 1 h, maximum 24 h by voice). A child cannot unpause by voice: unpause from a kids' assistant or a
  device marked as that child's is refused.
- **Blocking a device** is `security`: it can lock out the server, the hypervisor or HA. Devices marked `protected`
  (auto-proposed: anything in the homelab inventory, the router, this server's MAC) cannot be paused or blocked.
- **DNS-filter disable** is time-limited (≤ 60 min) and never permanent by voice. It is low risk for adults, but
  kids' and guest assistants do not get it, because it is how parental filtering is bypassed.
- **Guest password** is a secret. It is shown on `private` and `shared` screens, spoken only on `private` devices,
  never on `public` devices, never sent to the hosted model (the tool returns "shown" to the model, not the password).
- Until confirmations are on, `net_pause` and `net_block_device` are not shipped; the DNS timed toggle can ship as
  `change` because it reverts itself.

## 14. Foundations needed

| Foundation | For | Without it |
|---|---|---|
| Fast path (typed actions, canned templates) | outage answers offline | the model answers, which fails exactly when needed |
| [Notification service](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications) | outage and new-device notices | ask-only |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) | pause end, filter re-enable | rely on the filter's timer; pause not shipped |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | QR, tables | password spoken on private devices only |
| [Device capabilities](../module-investigation/presentation-and-device-capabilities.md#52-vocabulary-proposal) (`privacy`) | password and client-list rules | treat every device as `shared` |
| People | groups per person | groups by name only |

**Useful first version (S):** the outage detector with layers 1, 2, 4–6, the fast-path "is the internet down", the
guest Wi-Fi card from a vault entry, Pi-hole or AdGuard timed disable.

## 15. Open questions

1. **Which router or controller** runs the house (UniFi, OpenWrt, Fritz!Box, OPNsense, or an ISP box)? Only that
   adapter should be built first.
2. **Pausing children's devices:** wanted, and at which level (router, which a child cannot bypass by changing DNS, or
   the DNS filter, which is easier but bypassable)?
3. **New-device alerts:** run NetAlertX, or have this module read the router's client list and diff it?
4. **Device presence as a hint** for smart-home and reminders: acceptable to the household, or owner-only?
5. **Fresh speed tests by voice:** allowed, or last scheduled result only?
6. **Guest password spoken aloud** on private devices, or screen and phone only?
7. **Disagreement with [assistant-controls §15 Q9](assistant-controls.md#15-open-questions)**, which leaves the speed
   test out: I put it here, read from Speedtest Tracker by default so it costs nothing.
8. **Disagreement with [core-tools §5.5](core-tools.md#55-system-status)**: its own internet probe would give a second,
   possibly conflicting answer; I propose `system_status` reads this module's verdict when the module is on.
