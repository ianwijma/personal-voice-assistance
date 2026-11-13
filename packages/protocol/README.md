# @pva/protocol

The messages between the browser UI and the assistant's `serve` mode, shared by both sides. The design and the behaviour behind each message are in [docs/UI-AND-MODULES.md §2](../../docs/UI-AND-MODULES.md#2-protocol).

- `client.ts` / `server.ts`: every text message as an Effect `Schema` (`ClientMessage`, `ServerMessage`, tagged on `type`).
- `settings.ts`, `snapshot.ts`, `common.ts`: settings forms, module and engine info, history, traces, ids, error codes.
- `frames.ts`: binary audio frames (8-byte header + PCM s16le), zero-copy encode/decode, `micSequenceGap`.
- `codec.ts`: `encodeClientMessage` / `decodeClientMessage` and the server equivalents. Decoding returns `Ok`, `Unknown` (ignore) or `Invalid`.
- `constants.ts`: `PROTOCOL_VERSION` (and when to bump it), sample rates, limits, close codes.
- `@pva/protocol/examples`: one valid example of every message, for tests, mock servers and scripted clients.

Browser-safe: only ECMAScript built-ins. `pnpm check` compiles `src` with no Node types and no DOM (`tsconfig.json` here). Importing the package ships Effect `Schema` to the browser (about 80 KB gzip, measured in `docs/research/web-stack.md`).
