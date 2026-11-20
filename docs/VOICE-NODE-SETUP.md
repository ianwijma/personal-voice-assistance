# Setting up a voice node (a Raspberry Pi in a room)

A **voice node** is a small Linux box with a microphone and a speaker (a Raspberry Pi with a USB speakerphone, a VM,
an old laptop) that becomes the assistant in a room. It streams its microphone to the server and plays the replies;
every speech engine and the language model stay on the server. You say a wake phrase ("Hey Jeff, what time is it?"),
it answers once and is asleep again. It shows up in admin › **Devices** › **Voice nodes** and gets assistants, wake
phrases, a voice, volume and its sound devices like any other device. Design and status: [VOICE-NODES.md](VOICE-NODES.md).

**What the box needs**

- Raspberry Pi OS Lite **64-bit** (arm64) or Debian/Ubuntu on x86-64, with systemd. 32-bit (`armv7l`, `armv6l`) is
  refused. About 150 MB of disk (the node brings its own Node.js runtime; nothing else from this repository).
- `curl` (`sudo apt install curl`). The installer installs the audio tools it needs when they are missing.
- **Audio, ALSA or PipeWire.** The default is a *system service* that uses **ALSA** directly (`arecord` / `aplay`, the
  `alsa-utils` package): right for a headless box, works without anyone logged in. On a desktop machine where
  PipeWire owns the sound card, install as that user's service instead with `--user <name>` (it uses `pw-record` /
  `pw-cat`, the `pipewire-bin` package, and turns on lingering so it runs without a login). A USB speakerphone with
  hardware echo cancellation is recommended: without it the node hears its own replies (the server's echo gate and
  "phrase needed" keep that from acting, but it costs decoding).
- The box must reach the server: the server must listen on the network (`SERVE_HOST=0.0.0.0` in `.env`, not the
  default `127.0.0.1`), and the box uses the server's LAN address, such as `https://192.168.1.20:8787`.

**On the server**

`pnpm serve` builds the node program too (`pnpm --filter @pva/node bundle` → `apps/node/dist`) and serves it under
`/node/`; if that build fails the server still starts and prints `voice node bundle not built: /node/* answers 404`.
A service that runs `pnpm start serve` directly must run `pnpm --filter @pva/node bundle` first (add it to the unit's
`ExecStartPre`, or run `pnpm serve` instead). Check: `curl -k https://<server>:8787/node/manifest.json` prints JSON.
`PVA_ADMIN_PASSWORD` must be set (pairing is done from admin). `PVA_NODE_DIR` serves another directory.

**Adding one**

1. Admin › **Devices** › **Voice nodes** › **Add voice node**. Give it a name (or leave it empty: the box's host
   name) and check the server address the node will use: it is prefilled with the address admin itself uses, so
   change `localhost` or `127.0.0.1` to the server's LAN address (the dialog warns). **Get code**.
2. The dialog shows a one-time code (valid 10 minutes) and a command. On the box, in a terminal or over ssh, run it,
   for example:

   ```sh
   curl -fsSL http://192.168.1.20:8787/node/install.sh | sudo sh -s -- --server http://192.168.1.20:8787 --code K7QM2XHP
   ```

   It downloads the pinned Node.js runtime (checked against its SHA-256), the node program and its boot guard
   (checked against the server's manifest), creates the `pva-node` user (in the `audio` group), pairs with the code,
   and starts the `pva-node` systemd service. It takes a few seconds plus the runtime download.
3. The dialog moves on by itself: "*name* is paired". **Open its page**: Online, the version and "up to date", the
   box, the audio backend and its devices, and Identify / Test speaker / Restart.

The first node seeds **Every voice node** with the browsers' assistants and wake phrases. A node answers **one
question per wake phrase**: its assistants get no "keep listening" window unless you give one on the node's
Assistants section. "Answers without a phrase" on a node asks you to confirm, because the node hears the whole room.

**TLS and the pin.** With `SERVE_TLS_CERT` / `SERVE_TLS_KEY` set (a self-signed certificate is fine) the command
pins the certificate's public key, so the box needs no CA and trusts only your server:

```sh
curl -fsSL -k --pinnedpubkey 'sha256//<base64>' https://192.168.1.20:8787/node/install.sh | sudo sh -s -- --server https://192.168.1.20:8787 --tls-pin sha256:<hex> --code K7QM2XHP
```

`-k` only skips the CA check; curl and the node both refuse a server whose key does not match the pin (the node logs
"the server's certificate does not match the pin" and sends nothing). The pin is the SHA-256 of the certificate's
public key, so a renewal with the same key keeps it; a new key means pairing again. Check it on the server with
`openssl x509 -in cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256`. Behind a
reverse proxy with a self-signed certificate, paste the proxy's pin in the dialog. Plain `http://` works too, with an
**Unencrypted** badge: the room's audio and the node's key then travel in the clear on your network.

**Updating.** The node updates itself from its server: it checks before every connection, so restarting the server
after an update (`git pull && pnpm serve`, or restarting your service) updates every node within seconds. After only
`pnpm --filter @pva/node bundle`, the node page shows **Update pending** within 5 s and **Update now** updates it at
once. A new release that cannot reach the server's welcome in three starts is rolled back to the previous one.

**Removing.** The node's page › **Remove voice node**: the node is disconnected (it logs that it was removed and
retries every 10 minutes), its key stops working and its own settings go. To bring it back, **Add voice node** again
and run the new command on the box (it pairs over the old key). To take the program off the box:
`curl -fsSL <server>/node/install.sh | sudo sh -s -- --uninstall`.

**Troubleshooting**

- Logs: `journalctl -u pva-node -f` (a `--user` install: `journalctl --user -u pva-node -f` as that user). Every
  answered turn prints its latency line.
- `this node was removed from the assistant or paired again elsewhere; pair it again` / `connection lost (4403 …)`:
  the node was removed in admin, paired again from another box, or its `/etc/pva-node/node.json` was copied. Add it
  again in admin and run the new command.
- The installer says `404` / `not_built`, or the dialog says "The node program is not built on this server": run
  `pnpm --filter @pva/node bundle` on the server (or restart it with `pnpm serve`) and try again.
- `too many wrong codes: try again in N s`: wrong codes are slowed down per address; wait, or get a new code.
- `expired` / `bad_code`: codes last 10 minutes and work once; at most three are open at a time (a fourth cancels the
  oldest). Get a new one.
- The page says **Missing tools** (`arecord`): `sudo apt install alsa-utils` on the box (or `pipewire-bin` for `--user`).
- No sound, or the wrong microphone: the node's **Sound devices** lists what the box reported; "System default" uses
  ALSA's `default`. A chosen device that is gone falls back to the default and shows the last error.
- Never online: from the box, `curl <server>/node/manifest.json` must work (firewall, `SERVE_HOST`, the address in
  `/etc/pva-node/node.json`).
