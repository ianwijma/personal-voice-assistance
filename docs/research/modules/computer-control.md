# Computer control

Research write-up, 2026-11-18. Not an approved design. Shared foundations are named as in [`README.md`](README.md) and
linked, not redesigned. Outside facts carry a link; **[unverified]** marks what I could not confirm against a primary
source; **[local]** marks what was seen on this machine without probing anything. Latency figures are targets to be
measured with `TurnTrace`, not claims.

## 1. Summary

Raycast-style control of the owner's desktop or laptop by voice from any room: open an app or a URL on the PC, media
keys and volume, send text to the PC's clipboard and read it back, type dictated text into the focused window, move
and maximise windows, lock, sleep, wake it with Wake-on-LAN, show a screenshot of it on a stage, and run a named script
the owner wrote. The backing is a **small companion agent on the PC** that connects *out* to our server like a voice
node does, declares what it can do, and runs only a closed set of verbs plus owner-named scripts.

- **Boundary.** [assistant-controls](assistant-controls.md) owns volume, mute and sleep *of our own devices*; this
  module owns the PC's. [smart-home](smart-home.md) owns Home Assistant entities; if the owner already runs an HA desktop
  agent, that path is an *adapter* here, not a second module. [core-tools](core-tools.md) `system_status` reports on the
  assistant server itself, [homelab](homelab.md) on other servers; this module is about the machine the owner sits at.
  [t3-code](t3-code.md) runs coding agents; this module never starts an agent.
- **Priority: second wave.** Useful to a developer every day ("open the PR on my laptop", "pause the music on the PC"),
  but nothing else depends on it, and its write half is only safe after risk classes, confirmations and trusted devices.
- **Effort: L overall; Linux v1 M.** The agent reuses the voice-node client's pairing, credential and self-update code
  (`docs/VOICE-NODES.md` on the unmerged node branches). Linux first (Wayland makes input and screenshots the hard part),
  macOS and Windows each add an S–M backend.

## 2. What others do

| Who | What | Copy | Avoid |
|---|---|---|---|
| [Raycast](https://manual.raycast.com/ai/ai-extensions) / Alfred | Local launcher: apps, window layouts, clipboard history, script commands, quicklinks; AI extensions with Ask / Always Allow per tool | Script commands as owner-named units; window layouts by name; a clipboard *history* the owner controls | Running on the PC only: no remote control from another room |
| [KDE Connect](https://userbase.kde.org/KDEConnect) | Phone ↔ PC pairing over TLS on the LAN; plugins `runcommand` (owner-defined commands), `mprisremote`, `clipboard`, `share` (open URL or file), `remotekeyboard`, `lockdevice`; [`kdeconnect-cli --execute-command`](https://thegeekdiary.com/kdeconnect-cli-command-examples) | Owner-defined command list, never free shell; pairing with a verification key; media over MPRIS | Clipboard sync as a default (Android blocks background clipboard since 10) |
| HA desktop agents: [go-hass-agent](https://github.com/joshuar/go-hass-agent) (Linux), [LNXlink](https://pypi.org/project/lnxlink/) (Linux, MQTT), [HASS.Agent](https://github.com/hass-agent/HASS.Agent) (Windows, MQTT) | Sensors (active app, idle, battery) and commands: lock, suspend, power off, open URL, send keys, custom scripts as HA buttons; HASS.Agent's optional service runs elevated | Reuse when installed; power commands as typed buttons | Elevated services; arbitrary D-Bus calls exposed (go-hass-agent can [run any D-Bus call](https://github.com/joshuar/go-hass-agent) from an HA action) |
| Desktop MCP servers (e.g. `linux-desktop-mcp`, Windows-MCP) **[unverified, directory listings]** | Screenshot, click, type for a computer-use model | — | A hosted model driving mouse and keyboard on the owner's logged-in desktop by voice |
| SSH from the server | `ssh pc 'playerctl play-pause'` | Nothing new to install on the PC | A key on the server that is a shell on the PC; GUI calls need the session's `DBUS_SESSION_BUS_ADDRESS` and `WAYLAND_DISPLAY` |

The pattern across the good ones: the PC defines the verbs, the remote side picks among them.

## 3. Example conversations

1. "Hey Jeff, open the voice assistant repo on my laptop." → `pc_open { target: "laptop", what: "https://github.com/…/personal-voice-assistance" }` → "Opened on the laptop." (owner's alias "voice assistant repo" → URL.)
2. "Pause the music on the PC." → `pc_media { action: "pause" }` (MPRIS) → earcon only.
3. "Turn the desktop down to thirty percent." → `pc_volume { set: 30 }` → "Desktop volume thirty."
4. "Send this to my clipboard: the wifi code is eight four two one." → draft "Copy 'the wifi code is 8421' to the desktop clipboard?" → "Yes." → "Copied."
5. "What's on my clipboard?" → "It's a link to a GitHub pull request, number 91. Read the whole thing?" (only on trusted devices; §13).
6. "Type: thanks, merged, will deploy tonight." (study speaker, owner at the desk) → "Typing into Slack on the desktop: 'Thanks, merged, will deploy tonight.' Go?" → "Go." → typed. **Screen helps:** the confirm card shows the text and the target window.
7. "Show me my desktop." → `pc_screenshot` → screenshot `image` on the kitchen tablet, with the active window's title as caption. **Needs a screen.**
8. "Put the browser on the left half." → `pc_window { app: "firefox", layout: "left-half" }` → done.
9. "Wake up the gaming PC." → `pc_wake` (magic packet) → "Sent the wake signal. It's usually up in about forty seconds; I'll say when." → "The gaming PC is on."
10. **Ambiguous:** "Lock the computer." with two paired PCs → "The desktop or the laptop?"
11. **Failure:** "Open Spotify on the laptop." → "The laptop isn't connected. It may be asleep or off the network."
12. **Refused:** "Run rm minus rf on the desktop." → "I can only run the scripts you've set up for the desktop: backup photos, start the game server, and clean downloads."

## 4. Tools

Risk classes are module-definition [§B.5](../module-investigation/module-definition-config-and-dependencies.md#b5-risky-tools)'s
(`read / change / message / money / security`), with the template's three in brackets: `read` = safe, `change` = changes
data, `message`/`security` = outward-facing or costly. One tool per verb family, `target` resolved by the server from the
paired PCs' names and aliases (default: the PC paired to the person, else the only one).

| Tool | Parameters | Returns | R/W | Risk | Latency (target) | Fast path |
|---|---|---|---|---|---|---|
| `pc_status` | `target?` | online, locked, idle minutes, active app title (if allowed), battery, volume | R | read | < 300 ms (agent cache) | yes |
| `pc_media` | `target?`, `action: play \| pause \| toggle \| next \| previous`, `player?` | player and track | W | change | < 300 ms | yes |
| `pc_volume` | `target?`, `set?: 0–100`, `step?: up \| down`, `mute?` | new level | W | change | < 300 ms | yes |
| `pc_open` | `target?`, `what: url \| app alias \| file alias` | what opened | W | change | 0.3–1 s | yes for aliases |
| `pc_clipboard_set` | `target?`, `text` (≤ 4,000 chars) | done | W | change (confirm off trusted devices) | < 300 ms | no |
| `pc_clipboard_get` | `target?` | text, cut to 2,000 chars, type hint (url, code, text) | R | **security** (may hold secrets) | < 300 ms | no |
| `pc_type` | `target?`, `text`, `submit?: false` | the window it went to | W | **security** | 0.3–2 s (typing speed) | no |
| `pc_window` | `target?`, `app?`, `layout: left-half \| right-half \| maximise \| minimise \| next-screen \| focus` | done | W | change | < 500 ms | yes |
| `pc_lock` | `target?` | locked | W | change | < 300 ms | yes |
| `pc_sleep` | `target?`, `kind: suspend \| screen-off` | done | W | change (confirm if a call or a long job runs) | < 500 ms | yes |
| `pc_wake` | `target` | packet sent; job watches for the agent to connect | W | change | < 100 ms + boot | yes |
| `pc_screenshot` | `target?`, `which?: screen \| window` | `image` presentation; nothing goes to the model unless asked | R | **security** | 0.5–2 s | no |
| `pc_run` | `target?`, `script: dynamic` (owner-named) | exit status, first 500 chars of output | W | per script, owner-set; default **security** | script-dependent; long → task | yes when the script has no parameters |

**Not offered, by design:** arbitrary shell commands, unlock, power off by default (owner may add it as a script), mouse
control, reading files, reading other windows' contents, the PC's microphone or camera.

## 5. Integrate or build

| Option | For | Against |
|---|---|---|
| **A. Own companion agent (`pva-desk`)**, a new device kind that dials out to our WebSocket with a pairing code, like a voice node | No inbound port or SSH key; one pairing UI for nodes and PCs; declares capabilities in `hello`; closed verbs we define; can also *be* a voice front end later (a desk mic) | We build and ship it for three OSes; Wayland input and screenshots need portals |
| B. Pair with the PC's **KDE Connect** daemon as a peer device (our server pretends to be a phone) | Already installed on many Linux desktops, exists for [Windows and macOS](https://kdeconnect.kde.org/download.html) **[unverified for macOS maturity]**; runcommand, MPRIS, share, clipboard, remote keyboard, lock all exist | We must implement the protocol (TLS, identity packets, UDP discovery on 1714–1764) in Node; no window management or screenshot; its runcommand list is edited on the PC, outside our admin |
| C. **HA desktop agent** (go-hass-agent, LNXlink, HASS.Agent) through [smart-home](smart-home.md) | Zero new code on the PC if installed; HA already holds the entities | Commands are HA buttons with no parameters, so no typing or clipboard text; HASS.Agent's elevated service; latency adds an HA and MQTT hop |
| D. SSH from the server | Nothing to install | A server-held key is a shell on the PC; GUI calls need session environment; worst blast radius |

**Recommendation: A, with C as a zero-install adapter for what HA already exposes (lock, suspend, media) and B kept
as a later adapter for KDE users.** D is rejected. The agent is a single binary; writing it in TypeScript keeps one
language and the node client's code, packaged as a Node [single executable application](https://nodejs.org/api/single-executable-applications.html)
(large, ~60–100 MB **[unverified]**); Go would give a ~10 MB binary but a second language. Owner's call (§15).

**Linux backends (first).**

| Verb | Backend | Note |
|---|---|---|
| media | MPRIS over D-Bus (`playerctl`, or `dbus-next` in process) | works on X11 and Wayland |
| volume | `wpctl set-volume @DEFAULT_AUDIO_SINK@ 30%` (PipeWire), `pactl` fallback | |
| open | `xdg-open` / `gio open` | URL allowlist by scheme: `https`, `http`, owner aliases; no `file://` outside aliases |
| clipboard | `wl-copy` / `wl-paste` on Wayland, `xclip` on X11 | |
| type | [`wtype`](https://github.com/atx/wtype) (virtual-keyboard protocol, wlroots compositors) or the portal; `ydotool` needs `/dev/uinput`, usually root or udev rules ([README](https://sources.debian.org/src/ydotool/1.0.4-3/README.md)) | GNOME and KDE: xdg-desktop-portal **RemoteDesktop** with libei, which asks the user once for consent ([libei in portals](https://gitlab.freedesktop.org/libinput/libei/-/issues/1)); prefer it over uinput |
| window | KWin scripting over D-Bus, `swaymsg`, `hyprctl`, `wmctrl` on X11; GNOME has no public window API without an extension **[unverified]** | per compositor; declared in capabilities |
| lock / sleep | `loginctl lock-session`, `systemctl suspend` (logind policy allows the active user) | |
| screenshot | xdg-desktop-portal **Screenshot** (asks once), `grim` on wlroots, `spectacle -b -n -o` on KDE | |
| scripts | executables in `~/.config/pva-desk/scripts/` listed in the agent's own config | the agent, not the server, owns the list |

**macOS:** `osascript` (media, volume, open, window via System Events), `pbcopy`/`pbpaste`, `pmset sleepnow`,
`screencapture -x`, Shortcuts (`shortcuts run "Name"`) as the script mechanism; Accessibility and Screen Recording
permissions granted once. **Windows:** PowerShell and Win32 (`SendInput` for typing, `LockWorkStation`,
`SetSuspendState`), media keys via virtual key codes, `Graphics.CopyFromScreen`. All **[unverified in detail]**.

**Wake-on-LAN** is sent by the server (a UDP magic packet to the broadcast address on port 9), or by HA's
`wake_on_lan.send_magic_packet` when the server is not on the PC's subnet (Proxmox VMs on a bridged LAN are fine).

## 6. Data

| What | Scope ([Module store](../module-investigation/shared-state-jobs-and-notifications.md#43-scopes)) | Schema | Read by others |
|---|---|---|---|
| Paired PCs | household settings + vault | `{ id, name, aliases[], owner: Person, os, mac?, wakeVia: "server" \| "ha", credentialRef }` | presence hints (online/idle) |
| Open aliases | person | `{ spoken: "voice assistant repo", kind: url \| app \| file, value }` | — |
| Scripts | on the PC (agent config), mirrored read-only into our store at connect | `{ id, label, spoken[], risk, params?: [] , timeoutS }` | routines (as steps) |
| Last state | device (the PC) | `{ online, locked, idleMin, activeApp?, battery?, volume, at }` | ambient line "Desktop: in use" |
| Clipboard sends | conversation | text and target, dropped with the conversation | — |

Clipboard contents and screenshots are never stored server-side beyond the `/media/` cache's one day, and screenshots
are marked `personal`.

## 7. Long-running work and events

- **Wake:** a [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) `task`
  waits up to 3 minutes for the agent's `hello`, then reports on the origin device. Not re-run after a restart.
- **Scripts over 8 s** become a `task` that returns "started" and reports the exit status later.
- **Events** ([Event bus](../module-investigation/shared-state-jobs-and-notifications.md#5-event-bus)):
  `computer-control.pc.online`, `.offline`, `.locked`, `.idle` (debounced 60 s). Routines can react ("when the desktop
  locks after 23:00, turn off the study lights"). Listens to nothing.
- **Restart:** agents reconnect with back-off; nothing is lost but in-flight typing, which is never retried.

## 8. Presentation

With a screen ([Presentation](../module-investigation/presentation-and-device-capabilities.md#32-catalogue-of-primitives-proposal)):
`pc_screenshot` → `image` (the character "holds it up" as for any image, caption = window title, `personal`);
`pc_status` → `facts`; `pc_type` and `pc_clipboard_set` → `confirm` showing the exact text and target window;
`pc_run` → `progress` for tasks; a pinned "Desktop" glance widget is possible but not proposed. Without a screen:
one sentence or an earcon; a screenshot answers "I can't show pictures here; I can put it on the study screen", and
never describes the screen unless asked (that would send the image to the model).

## 9. Notifications and proactive behaviour

Almost none. A wake that completes is reported (`normal`, origin device). A script the owner marks `notifyOnFinish`
reports its result. Battery low on the laptop, PC offline and similar are *not* spoken; they are ambient facts and an
inbox `low` at most. No "your PC has been idle for an hour" nagging.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | computer control on/off; may screenshots go to the hosted model on request | on; off |
| Module | paired PCs (pair / rename / forget), wake method, per-verb enable, typing confirm (always / off on trusted devices), clipboard read allowed | none; server; media, volume, open, lock on, the rest off; always; off |
| Assistant | which assistants get it (the owner's main and coding assistants), `offTools` | none |
| Device | `allowRisky` (trusted) per §B.5: required for `security` verbs | off |
| Person | default PC, open aliases | first paired PC |

**Secrets:** a per-PC credential issued at pairing (like node credentials), in the vault. **First run:** install the
agent on the PC (package or binary), run `pva-desk pair`, read the six-digit code into admin, approve the verbs the
agent offers, grant the portal consents on the PC once (RemoteDesktop for typing, Screenshot), set the MAC for wake.

## 11. Native tools and dependencies

| Need | Where | Missing → |
|---|---|---|
| `pva-desk` agent | the PC | module `unavailable` for that PC: "The desktop isn't paired." |
| `playerctl` or D-Bus, `wpctl`/`pactl`, `wl-clipboard`/`xclip`, `wtype` or portal, `grim`/`spectacle`, `xdg-open` | the PC (Linux) | the agent omits the verb from its capabilities: "I can't type on the desktop: it has no typing tool installed." |
| Accessibility, Screen Recording permissions | the PC (macOS) | same, with the System Settings path in admin |
| UDP broadcast to the PC's subnet, or HA | server or HA | "I can't wake the PC from here; set Home Assistant as the wake method." |

The agent reports these in its `hello`, so [Requirements and health](../module-investigation/module-definition-config-and-dependencies.md#c3-requirement-declaration-and-probing-proposal)
probes run *on the PC*, the first module whose requirements live on a non-speaker device.

## 12. Interaction with the rest of the system

- **Voice.** Targets ("the desktop", "my laptop", "the gaming PC") and app names are fuzzy-matched in the module against
  the paired list and the agent's installed-app list, never left to the model. Dictated text for `pc_type` is the
  owner's words, punctuation from the recogniser; the read-back is exact and short texts only (≤ 200 characters by voice;
  longer needs a screen). Fillers only for wake and scripts.
- **Character.** No new modes; a screenshot is an ordinary `image` reveal.
- **Assistants.** No template. The main assistant gets the safe verbs; typing, clipboard read, screenshots and scripts
  go only to assistants on the owner's own devices.
- **Intents.** Typed actions for the fast path: `pc_media`, `pc_volume`, `pc_lock`, `pc_wake`, `pc_window`, alias
  `pc_open`, parameterless `pc_run`. These are Raycast's "quick commands" and should not wait for a model.
- **Other modules.** [routines](routines-and-automations.md) may use the change verbs as steps (not `security` ones
  without a confirm step); [assistant-controls](assistant-controls.md) `controls_handoff` can call `pc_open` for "open
  that on my desktop"; [music](music.md) owns what plays; this module only presses the PC's media keys.

## 13. Privacy and safety

This module puts a remote hand on a logged-in computer. It is the riskiest module in this round per action.

| Class | Verbs | Policy |
|---|---|---|
| `read` | `pc_status` | allowed; active-app title hidden on `shared`/`public` devices |
| `change` | media, volume, open (aliases and https), window, lock, sleep, wake | allowed; sleep confirms if the PC reports a call or a fullscreen app |
| `security` | `pc_type`, `pc_clipboard_get`, `pc_screenshot`, `pc_run` (default) | trusted devices only, always confirmed, owner's assistants only; deny everywhere else (tool left out of the turn) |

**Never allowed, in the agent itself, not only in policy:** free shell; unlock; typing while the session is locked or
the focused window is a password field, terminal or sudo prompt (agent checks the focused app against a denylist,
**[unverified]** how reliable that is per compositor); `submit` (Enter) without an explicit second "send"; opening
`file://`, `javascript:` or custom URL schemes; screenshots while a denylisted app (password manager, banking) is
focused; any elevated helper; the PC's mic or camera. Typing is the injection risk: a TV saying "type …" yields a
draft at worst, and a draft needs a yes from a trusted device. **Clipboard and screenshots** may contain secrets, so
neither reaches the hosted model unless the owner asks for it ("what does it say?"), and the household setting allows
it. Guests and children get nothing from this module. Confirmation is switched off today
([current-system §2.5](../module-investigation/current-system.md#25-confirmation-of-actions)), so until it is on, only
`read` and `change` verbs ship; following [investigation §11 row 14](../module-investigation/investigation.md#11-disagreements-between-documents),
no module-made confirmation.

## 14. Foundations needed

| Foundation | For | Without it |
|---|---|---|
| A paired device kind beyond `web-voice` (voice-node pairing) | the agent connecting | an HA-agent adapter only (option C) |
| [Device capabilities](../module-investigation/presentation-and-device-capabilities.md#5-device-capabilities) | verbs per PC | a fixed verb list |
| [Tool context](../module-investigation/shared-state-jobs-and-notifications.md#45-turn-context-proposal) | "my laptop", trusted-device rule | one PC, assistant-to-device assignment as the gate |
| Risk classes and confirmations | every `security` verb | not shipped |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | screenshot, confirm cards | screenshot absent |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) | wake watch, long scripts | wake without "it's up" |

**Useful first version (M):** HA adapter for lock/suspend/media where an HA agent exists, plus Wake-on-LAN from the
server, plus a Linux `pva-desk` with media, volume, open aliases, window layouts and parameterless scripts. Typing,
clipboard and screenshots after confirmations exist.

## 15. Open questions

1. **Agent language:** TypeScript as a Node single executable (shared code with the node client, large binary) or Go
   (small binary, second language)?
2. **Which desktops:** KDE Plasma, GNOME or a wlroots compositor? This decides typing and window management, and whether
   the KDE Connect adapter (B) is worth building at all.
3. **Typing by voice at all?** It is the highest-value and highest-risk verb. Allow it only from the study devices, or
   only with the confirm card on a screen?
4. **Screenshots to the hosted model:** never, or on explicit request ("what's on my screen")?
5. **Scripts' home:** on the PC in the agent's config (my proposal: the PC owner decides what can run there), or in
   our admin (one place to edit, but the server then defines code that runs on the PC)?
6. **Power off and reboot** as built-in verbs, or only as owner scripts?
7. **Disagreement with [assistant-controls §15 Q9](assistant-controls.md#15-open-questions)**: it leaves the
   landscape's `system` module (speed test, device volume) out. I agree for our devices, but "device volume" for a PC
   belongs here, and the speed test belongs in [network](network.md), not nowhere.
8. **Disagreement with [mcp-client §5.4](mcp-client.md#54-a-vetted-starter-list)**: desktop MCP servers
   (screenshot-click-type for computer-use models) should not be on any starter list for a voice assistant; I would
   have the MCP client refuse to expose such tools to assistants on shared devices.
