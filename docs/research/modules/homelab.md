# Homelab

Research write-up, 2026-11-18. Not an approved design. Shared foundations are named as in [`README.md`](README.md) and
linked, not redesigned. Outside facts carry a link; **[unverified]** marks what I could not confirm against a primary
source; **[local]** marks what was seen on this machine without probing anything (nothing on the owner's network was
contacted). Latency figures are targets to be measured with `TurnTrace`.

## 1. Summary

Server administration by voice for the owner's homelab: "is everything up?", Proxmox guests and their backups, Docker
containers and stacks, systemd services, uptime monitors, alerts from Grafana or Alertmanager read aloud and routed
through the notification service, disks, UPS and pending updates, a status board on a stage, and a small set of
**owner-named actions** such as "restart the media server", always confirmed. Read-only by default; writes exist only
for targets the owner listed.

- **Boundary.** [core-tools](core-tools.md) `system_status` reports on the assistant server and its modules; this
  module reports on *other* machines. [network](network.md) owns routers, DNS filters, VPN and internet reachability.
  [dev-tools](dev-tools.md) owns deploy platforms (Coolify, Dokploy, Vercel, Kubernetes deploys) seen as "did my deploy
  work"; this module owns the hosts and containers underneath. [mcp-client](mcp-client.md) can bring any Proxmox, Docker
  or Grafana MCP server; this module is the voice-shaped native subset (§5.3). [notifications](notifications.md) owns
  inbound hooks; alerts arrive through them.
- **Priority: second wave.** High value for this owner, and the read half needs no new foundation; the write half needs
  confirmations, trusted devices and per-target risk.
- **Effort: M** for status (Proxmox, Docker, one uptime monitor, alerts via hook, status board) and named restarts;
  **L** with every backend (Komodo, Portainer, PBS, NUT, SMART, updates across hosts).

## 2. What others do

| Who | What | Copy | Avoid |
|---|---|---|---|
| Homepage, Homarr, Dashy | Read-only dashboards with widgets for Proxmox, Uptime Kuma, Speedtest Tracker, Portainer | One status board, a widget per backend; status over credentials with read scope | — |
| Uptime Kuma / Gatus | Monitors and status pages; Kuma exposes Prometheus `/metrics` with an API key ([Internal API](https://github.com/louislam/uptime-kuma/wiki/Internal-API)) | Ask the monitor, don't re-implement monitoring | Polling every service from the assistant |
| Grafana / Alertmanager | Alerts grouped, routed to contact points; Alertmanager webhooks POST a JSON group (`version: "4"`, `status`, `alerts[]`, `groupKey`) and are unsigned ([guide](https://hookdeck.com/webhooks/platforms/guide-to-prometheus-alertmanager-webhooks-features-and-best-practices)) | Grouping and `resolved` messages; push, not poll | Reading every firing alert aloud |
| Proxmox MCP servers ([canvrno/ProxmoxMCP](https://github.com/canvrno/ProxmoxMCP), ProxmoxMCP-Plus, others) | Proxmox API as agent tools, some with job tracking | Task-id tracking for long operations | Full coverage: **[local]** this session's tool list includes a Proxmox MCP server with about 290 tools, among them `delete_vm`, `stopall_node`, `rollback_vm_snapshot`, `vm_agent_exec` and `proxmox_api_raw`; far past the 25-tool budget and every risk line |
| [Portainer MCP](https://github.com/portainer/portainer-mcp), [Grafana MCP](https://github.com/grafana/mcp-grafana) | Official servers with read-only switches (`-read-only`; `--disable-write`) | Read-only flags at the server, plus a viewer-role credential | — |
| HA | Proxmox VE, Glances, NUT, Uptime Kuma integrations as entities | Use HA's entities when the owner already has them | Two sources of truth for the same VM |

## 3. Example conversations

1. "Hey Jeff, is everything up?" → `lab_status` → "All 23 monitors are up. One alert: disk on the NAS is 91 percent full."
2. "What's running on Proxmox?" (screen helps) → "Fourteen guests running, two stopped: the old Windows VM and the test container. Node load is low." Screen: status board.
3. "Did last night's backups work?" → `lab_backups` → "Twelve of thirteen succeeded. The Immich container failed at 02:14: not enough space on the backup store."
4. "Restart the media server." → named target `media` = LXC 105 on node `pve1` → "Restart Jellyfin, container 105? Two streams are playing." → "Yes." → "Restarting… It's back up after 18 seconds."
5. "Why is Nextcloud down?" → `lab_status { target: "nextcloud" }` → "Uptime Kuma says it has failed for six minutes with a 502. Its container is running, restarted twice in ten minutes. Want the last log lines on the study screen?"
6. **Alert announced:** (Alertmanager hook) "Heads up: the UPS is on battery. Estimated 22 minutes left." (`high`, owner devices)
7. "Any updates pending?" → "Proxmox has 14 package updates on both nodes, none security-flagged. Three containers have newer images: Immich, Paperless and Uptime Kuma." 
8. **Ambiguous:** "Stop the database." → "There are three: the Postgres container for Immich, the one for Paperless, and the MariaDB VM. Which one?"
9. **Refused:** "Shut down the Proxmox host." → "I can't shut down hosts by voice. I can put a shutdown link on the study screen."
10. **Failure:** "How's the cluster?" → "I can't reach Proxmox at 10.0.0.5. If the node is down, the uptime monitors will say so too: they report three hosts unreachable since 03:40."

## 4. Tools

Risk classes are [§B.5](../module-investigation/module-definition-config-and-dependencies.md#b5-risky-tools)'s; template
equivalent in brackets. Targets are resolved by the module from an owner-edited inventory (§6), not by the model.

| Tool | Parameters | Returns | R/W | Risk | Latency (target) | Fast path |
|---|---|---|---|---|---|---|
| `lab_status` | `target?` (spoken name, host, or "all"), `detail?: summary \| full` | worst first: down monitors, firing alerts, stopped-but-should-run guests, disks > threshold, UPS | R | read (safe) | < 200 ms from cache | yes |
| `lab_guests` | `node?`, `state?: running \| stopped \| all` | Proxmox VMs and CTs: name, id, state, uptime, CPU, RAM | R | read | 0.2–0.8 s | yes |
| `lab_containers` | `host?`, `stack?`, `state?` | Docker containers or stacks: state, health, restarts, image age | R | read | 0.2–0.8 s | yes |
| `lab_services` | `host`, `unit?` | systemd units: active state, failed units | R | read | 0.3–1 s | yes |
| `lab_backups` | `since?: duration` (default 24 h) | Proxmox vzdump / PBS tasks: ok, failed, size, duration | R | read | 0.3–1 s | yes |
| `lab_alerts` | `state?: firing \| resolved`, `since?` | grouped alerts from the store (pushed in) | R | read | < 50 ms | yes |
| `lab_storage` | `host?` | pools and disks: used %, SMART health, ZFS state | R | read | 0.3–1.5 s | yes |
| `lab_power` | — | UPS status (`OL`, `OB`, `LB`), charge, runtime, load | R | read | < 100 ms (NUT cache) | yes |
| `lab_updates` | `host?` | pending package updates, newer container images | R | read | cached daily | yes |
| `lab_logs` | `target`, `lines?: ≤ 50` | last log lines, for a screen; summarised for speech | R | read (personal: may contain secrets) | 0.3–1 s | no |
| `lab_action` | `target` (named), `action: start \| stop \| restart \| shutdown` (only those the owner allowed for that target) | Proxmox task id or container result; then waits for health | W | **change or security, per target** (§13) | 1–60 s; > 8 s becomes a task | yes, as a typed action with a target |
| `lab_silence` | `alert`, `for: duration` (≤ 24 h) | Alertmanager silence id | W | change | < 500 ms | no |
| `lab_show_board` | `device?` | pins the status board on a screen | W | read | < 100 ms | yes |

Not offered: create, delete, migrate, snapshot rollback, resize, firewall, users, raw API passthrough, guest-agent
exec, `docker exec`, `apt upgrade`. Those stay in the web UIs or behind an MCP server the owner chooses on purpose.

## 5. Integrate or build

### 5.1 Backends

| Backend | API | Credential with the least power that works |
|---|---|---|
| Proxmox VE | REST `/api2/json` (`/cluster/resources`, `/nodes/{n}/qemu/{id}/status/current`, `…/status/reboot`, `/nodes/{n}/tasks`) | API token with privilege separation: effective rights are the intersection of user and token ACLs ([API token docs](https://pve.proxmox.com/pipermail/pve-devel/2020-January/041484.html)). Read: `PVEAuditor` on `/`. Write: a custom role with only `VM.PowerMgmt` on a **pool** holding the named targets |
| Proxmox Backup Server | REST, token | `DatastoreAudit` **[unverified role name]** |
| Docker | Engine API through [docker-socket-proxy](https://github.com/tecnativa/docker-socket-proxy) (`CONTAINERS=1`, `POST=0` for read; `ALLOW_RESTARTS=1` for restarts) | never the raw socket (root-equivalent); note `GET` still exposes logs and archives |
| Portainer | REST with `X-API-Key`; or its official MCP with `-read-only` | a user with read access to the chosen environments |
| Komodo | `/read`, `/execute`, `/write` POST APIs, `x-api-key` + `x-api-secret` headers ([client source](https://docs.rs/crate/komodo_client/2.1.1/source/src/request.rs)) | a non-admin user with read on stacks, execute only where allowed **[unverified per-resource grain]** |
| systemd | over SSH with a forced command (`command="pva-systemctl-ro"` in `authorized_keys`) running a fixed wrapper; or Cockpit's API **[unverified]** | read wrapper: `systemctl list-units --failed --output=json`, `is-active`; restart wrapper with a unit allowlist |
| Uptime Kuma | `/metrics` (Prometheus text, API key as basic-auth password), or published status page `/api/status-page/heartbeat/<slug>` | an API key; the socket.io API needs a login and is internal |
| Gatus | `GET /api/v1/endpoints/statuses` (JSON array) **[unverified for the current version]** | none or a bearer token |
| Alertmanager / Grafana | inbound: webhook contact point → [notifications](notifications.md) hook; outbound: Alertmanager `POST /api/v2/silences`; Grafana HTTP API for alert rules state | a Grafana service account with Viewer |
| UPS | NUT `upsd` on TCP 3493: `LIST VAR <ups>`, `ups.status`, `battery.runtime` ([protocol](https://networkupstools.org/docs/developer-guide.chunked/ar01s09.html), RFC 9271); apcupsd NIS as alternative | a NUT user without `instcmds` |
| Disks | `smartctl -j -H -A`, `zpool status -j` **[unverified flag on older ZFS]** via the same SSH wrapper; or Proxmox `/nodes/{n}/disks/list` | read wrapper |
| Updates | Proxmox `/nodes/{n}/apt/update` (GET lists, does not install); Diun or What's Up Docker for images | read |

### 5.2 Build: a thin native module

Build `packages/module-homelab` with one adapter per backend behind four internal interfaces (`Guests`, `Containers`,
`Monitors`, `Power`), a 30-second status cache refreshed in the background, and the inventory of named targets. Tools
answer from the cache, so "is everything up" is a fast-path read under 200 ms and never fans out to ten hosts in a turn.
No provider SDK is needed (plain `fetch` and `node:net`).

### 5.3 Native tools or MCP servers through the MCP client

| | Native (this module) | MCP servers via [mcp-client](mcp-client.md) |
|---|---|---|
| Tool count | ~13, voice-shaped | Proxmox servers 40–290 tools, Grafana ~50 **[unverified count]**; over the 25-tool cap |
| Targets | owner inventory: "media server" → CT 105 | raw ids; the model guesses |
| Risk | per target and action, confirm in core | per tool at best; "restart" on any VM is one tool |
| Fast path | yes (typed actions) | no (MCP tools have no `examples`) |
| Status board, alerts in | yes | no |
| Long tail ("show the ZFS ARC size", "which VM uses the GPU") | no | yes |

**Recommendation:** native for status, alerts and named actions; MCP for exploration, only with the server's read-only
switch (`--disable-write`, `-read-only`) and a read-only credential, only for an "Admin" assistant on trusted devices,
and allowlisted to a handful of `get_*`/`list_*` tools. A full-coverage Proxmox MCP server should never be exposed to a
voice assistant as is.

## 6. Data

| What | Scope | Schema | Read by others |
|---|---|---|---|
| Backends | module settings + vault | `{ kind, url, credentialRef, verifyTls, caPin? }` | — |
| Inventory (named targets) | household settings (`records` field) | `{ id, spoken[], backend, ref: { node, vmid } \| { host, container \| stack } \| { host, unit }, actions: ["restart"], risk: "change" \| "security", protected?: true, healthCheck?: monitorId, notes? }` | routines, briefing |
| Status cache | memory, snapshot in store every 5 min | per target: state, since, monitor, alerts | ambient line, briefing |
| Alerts | household | `{ groupKey, status, labels, summary, startsAt, endsAt?, receivedAt, announcedAt? }`, 30 days | notifications, briefing |
| Action log | household | `{ at, target, action, by: Actor, device, result, taskId }` | admin |

## 7. Long-running work and events

- **Polling fiber** per backend (30 s; 5 min for updates and SMART, daily for image updates). Push where available:
  alerts by hook, Proxmox tasks by polling the task id only while an action runs.
- **Actions** longer than 8 s are a [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler)
  `task`: issue, poll the Proxmox task (`/nodes/{n}/tasks/{upid}/status`) or container health, then confirm the linked
  monitor is green. Not re-run after a restart (non-idempotent); after a restart it reads the state once and reports.
- **Events:** `homelab.target.down`, `.up`, `homelab.alert.firing`, `.resolved`, `homelab.power.on-battery`,
  `homelab.backup.failed`. Listens to `notifications.hook.received` for its alert hooks.

## 8. Presentation

The status board is the visual centrepiece: a `list` grouped by host with a coloured state dot per target, or a
`table` (name, state, since, CPU, RAM) on large screens; pinned in a corner as a glance when the owner asks "keep the
lab status up". `lab_backups` → `table`; `lab_power` → `facts`; `lab_logs` → `text` in monospace, never spoken
verbatim; `lab_action` → `confirm`, then `progress` until healthy. A `chart` of the last hour's load is optional. The
character only presents; it does not look alarmed on red (CHARACTERS.md §2.3). Without a screen: worst item first,
counts for the rest ("and two minor ones"), ids never spoken, durations rounded.

## 9. Notifications and proactive behaviour

Through the [Notification service](../module-investigation/shared-state-jobs-and-notifications.md#82-priority-and-what-each-may-do):

| Source | Priority | Audience |
|---|---|---|
| UPS on battery, low battery | `critical` (low battery), `high` (on battery) | owner devices, phone |
| Alert with label `severity=critical` | `high` | owner devices; quiet hours: phone only |
| Monitor down > 5 min for a target marked `important` | `normal` | owner devices, else inbox |
| Backup failed, disk > 90 %, SMART failing | `low` | inbox, morning [briefing](briefing.md) |
| Resolved | none spoken; updates the inbox entry | — |

Rules: group by `groupKey`, one announcement per group per hour, never read label soup ("instance 10.0.0.12:9100")
aloud, use the alert's `summary` annotation. Shared rooms get nothing below `high`.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | homelab announcements to shared rooms; quiet-hours escalation to phone | off; on for `critical` |
| Module | backends; inventory with per-target actions and risk; disk threshold; status cache interval; hook ids for alerts | none; none; 90 %; 30 s |
| Assistant | which assistants (an "Admin" assistant; the main one read-only) | none |
| Device | `allowRisky`; may show logs | off; off |
| Person | — | — |

**First run:** create the Proxmox user `pva@pve`, a token with privilege separation, `PVEAuditor` on `/`; deploy
docker-socket-proxy read-only; paste URL and token in admin; **Test** lists guests; tick the targets that get spoken
names; for restarts, create a pool `voice-actions`, add the targets, grant a role with `VM.PowerMgmt` on that pool only;
point Alertmanager's webhook receiver or Grafana's contact point at the hook URL from [notifications](notifications.md).

## 11. Native tools and dependencies

| Dependency | Where | Missing → spoken |
|---|---|---|
| Network reach to Proxmox, proxies, monitors | server | "I can't reach Proxmox right now." The backend turns `unavailable`; others keep working |
| docker-socket-proxy container | each Docker host | that host's containers absent from status |
| SSH wrapper scripts (systemd, SMART) | each host | services and disks absent for that host |
| NUT server | the host with the UPS cable | `lab_power` says "No UPS is set up." |
| Trusted TLS or a pinned self-signed cert | backends | refuse plain HTTP to tokens on the LAN, as [t3-code §11](t3-code.md#11-native-tools-and-dependencies) does |

Health: one line per backend in [Requirements and health](../module-investigation/module-definition-config-and-dependencies.md#c5-pva-doctor-and-the-health-page).

## 12. Interaction with the rest of the system

- **Voice.** Spoken names come from the inventory ("media server", "the NAS", "Immich"); recogniser trouble with
  "Proxmox", "LXC", "Komodo", "Paperless" is solved by matching against that list, plus recogniser hotwords where
  supported. Numbers: guest ids never spoken, percentages rounded.
- **Fillers.** Reads are cache hits. Actions say "restarting" before the call; the result comes when health is green.
- **Agents.** An assistant template **"Admin"** (name suggestion "Ops"): brief, worst-first, never speaks logs or
  ids, always names the target and its current users before an action; modules `homelab`, `network`, `dev-tools`,
  `core-tools`; assigned to the study devices only.
- **Other modules.** [briefing](briefing.md) reads overnight failures; [network](network.md) supplies "internet down"
  so homelab does not misreport every external monitor; [routines](routines-and-automations.md) may call `lab_action`
  only for targets whose risk is `change`.

## 13. Privacy and safety

`change` in [§B.5](../module-investigation/module-definition-config-and-dependencies.md#b5-risky-tools) is "lights,
music, timers". Restarting a VM is not like a light: it interrupts other people and can take the house down. So risk is
**per target and action**, set by the owner, with these rules:

- Reads are `read`. Logs are `read` but `personal` (secrets leak into logs): screen only, trusted devices only.
- Start and restart of an ordinary target: `change`, **always confirmed** regardless of the class policy, with the
  target's current users in the question ("two streams are playing").
- Stop and shutdown: `security` (trusted device + confirm).
- **Protected targets** (the VM or host running this assistant, Home Assistant, the router VM, DNS, the hypervisor
  nodes themselves): no voice actions at all. The module refuses to stop what it runs on, detected by matching the
  server's own IPs and hostname against the inventory.
- Credentials enforce the same line: the write token can power-manage only the `voice-actions` pool.
- Guests, children, shared and public devices: status summary only ("everything is fine" / "something is down"), no
  names of services, no actions.
- Until confirmations are on ([current-system §2.5](../module-investigation/current-system.md#25-confirmation-of-actions)),
  `lab_action` is not shipped.

## 14. Foundations needed

| Foundation | For | Without it |
|---|---|---|
| `records` settings field on the wire | inventory | JSON text setting |
| [Notification service](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications) and the inbound hook | alerts | `lab_alerts` from Alertmanager's API by polling; nothing spoken |
| Risk classes, confirmations, trusted devices | `lab_action`, `lab_silence` | read-only module |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) | action tasks | short actions only, "it's restarting, check in a minute" |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | board, tables, logs | spoken only |
| [Module store](../module-investigation/shared-state-jobs-and-notifications.md#4-the-shared-data-layer) | alerts, action log | memory |

**Useful first version (S–M):** Proxmox read token + Uptime Kuma `/metrics` + one Docker host through the proxy,
`lab_status`, `lab_guests`, `lab_backups`, the fast-path "is everything up", spoken only.

## 15. Open questions

1. **Which backends exist?** Proxmox certainly; is Docker managed by Portainer, Komodo, Dockge or plain Compose, and
   which uptime monitor (Kuma or Gatus) and alerting (Grafana, Alertmanager, none) run today?
2. **Restarts by voice at all**, and from which devices? My default: named targets only, study devices only, always
   confirmed.
3. **Protected list:** which VMs and containers must never be touched by voice (my proposal: this assistant's host,
   HA, router, DNS, PBS, the nodes)?
4. **Alerts:** route Alertmanager/Grafana through our hook (my proposal) or keep them in the phone app the owner
   already uses and only *read* them here?
5. **The existing Proxmox MCP server [local]:** keep it for Claude Code only, or expose a read-only allowlisted slice
   of it to the Admin assistant through [mcp-client](mcp-client.md)?
6. **Disagreement with [§B.5](../module-investigation/module-definition-config-and-dependencies.md#b5-risky-tools):**
   `change` is too coarse for infrastructure; I propose per-target risk and a `protected` flag in the manifest's risk
   vocabulary, not only in this module.
7. **Disagreement with [mcp-client §5.4](mcp-client.md#54-a-vetted-starter-list):** I would add "server-side read-only
   switch required" as a condition for infrastructure servers in the vetted list, since annotations from untrusted
   servers are ignored anyway.
8. **Status board on which screen:** a pinned glance on the study screen permanently, or only on request?
