# Voice nodes in admin: evidence (N4)

Screenshots of package N4 of docs/VOICE-NODES.md (§7, §14), made by `apps/web/e2e/nodesEvidence.ts` against the mock
(`nodes` scenario) and the static export: `<name>-<theme>-<size>.png`, dark and light, desktop (1280 wide) and phone
(320 wide, scale 2).

| Name | What |
|---|---|
| `devices-with-nodes` | Devices › All devices: Browsers, then Voice nodes with Every voice node, Kitchen speaker (online), Living room (Update pending, Unencrypted, a last error), Garage (offline, a last error) |
| `add-node-address` | Add voice node, step 1, with the loopback warning (the prefilled address is the mock's 127.0.0.1) |
| `add-node-code` | Step 2: the code, the countdown, the pinned https command, waiting |
| `add-node-not-built` | Step 2 on a server without the node program |
| `add-node-paired` | Step 3: paired, Open its page / Add another |
| `node-page-status` | A node's page: Status and Actions (Living room) |
| `node-page-full` | The whole node page (Living room) |
| `node-page-assistants` | Assistants on a node: follow-up "Off: one answer per phrase (voice nodes)" |
| `node-page-sound` | Sound and Sound devices, with a microphone that is not connected |
| `every-voice-node` | The defaults page, without Look, Captions, the voice page or browser Audio |
| `node-answers-everything` | "Answers without a phrase" on a node: the note and the Save anyway dialog |
| `node-remove` | Remove voice node: the alertdialog |

What these show is the mock, not the real server (N2): see the N4 report for what the mock assumes.
