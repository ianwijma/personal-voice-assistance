# personal-voice-assistance

Low-latency, modular personal voice assistant. Node 22, TypeScript, Effect 4, pnpm workspace.

- Read `docs/ARCHITECTURE.md` before changing anything; the service interfaces in it are the contract.
- Effect is **v4** (`effect@^4.1`). Its API differs from v3. Use `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/src/**` as the reference.
- Provider SDKs may only be imported inside their adapter package.
- `pnpm check` and `pnpm test` must pass before a change is done.
- Latency claims are backed by `TurnTrace` numbers, not by reasoning.
