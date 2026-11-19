# Modules: plan for the deferred parts

Written 2026-11-19. It plans what [MODULES-PLAN.md](MODULES-PLAN.md) put outside its piece of work ("Order from here",
item 5): accounts and OAuth (the rest of P8), the google and t3-code modules, the MCP client, CalDAV in the calendar
module, calls and intercom, and streaming and WebSocket in the network helper. It is checked against the code on these
branches: `t3/modules-11-scaffold` at `5bfeca0d` (P1 to P6 and the scaffold, with `@pva/net`, the store, the scheduler,
`offThread` and `docs/MODULES.md`), `t3/modules-09-notify` at `d177f3ec`, `t3/modules-07-phrases` at `77e36eca`,
`t3/modules-10-present` at `3280b6ef`, `t3/module-calendar` at `7050c33e` and `t3/module-smart-home` at `e8f64ba8`.
None of it is on `main`.

Note, 2026-11-19 evening: the branches named above have moved since (their final heads are in
[MODULES-STATUS.md](MODULES-STATUS.md)); nothing that changed there alters the order or the designs below. Two things
to read first when this plan is taken up: the owner's instruction on reviews (one Sol round per pull request, more only
where something is badly broken) replaces the review rounds of MODULES-PLAN §6 for this plan too; and the owner wants
to try out the modules first and may rework how modules and tool calls are done, so check this plan against the code
again before starting it.

Everything in MODULES-PLAN §2 (decisions), §3 (rules for every PR, what host code must survive) and §6 (review)
applies here unchanged. Where this document and a research document disagree, this document wins. Where the research
and the code disagree, the code wins, and the section says so.

## 1. Order, and why

| Step | What | Why here |
|---|---|---|
| 1 | **The network helper**: more request kinds, then streams and sockets (§3) | It depends on nothing that is not built, it is small and mechanical, and it unblocks four of the other items: CalDAV needs its request kinds, OAuth needs a form body, the MCP client and t3-code need a streamed answer, Home Assistant needs a WebSocket. |
| 2 | **Accounts and OAuth** (§4), in three pull requests: the account model with pasted credentials, then OAuth with a client the owner registered, then OAuth for an MCP server | The largest design risk, and google, t3-code, CalDAV and the MCP client's tokens all wait for it. The first of the three is enough for CalDAV and the MCP client, so they do not wait for OAuth. |
| 3 | **mcp-client** (§5), first with pasted tokens | Needs only steps 1 and the first account PR. Every outside tool it brings is a security question, and answering it once here is what t3-code reuses. |
| 4 | **CalDAV in the calendar module** (§6) | Needs only step 1 and the first account PR; the calendar already has a provider interface for it. |
| 5 | **google** (§7) | Needs OAuth with the owner's own client (the second account PR). Owner setup (a Google Cloud project) is the slowest part and can start in parallel. |
| 6 | **t3-code** (§8) | Needs OAuth for an MCP server (the third account PR), which is the second account PR plus discovery and registration. |
| 7 | **calls and intercom** (§9) | Nothing depends on it; it changes shared files (protocol, server, voice page, the phrase decision, the notification service); it needs decisions about who may call whom that nothing else needs. Written last, alone, as the plan already said. |

The Home Assistant module's move from polling to a WebSocket is a module pull request after step 1 (§3.4); it can be
written in parallel with steps 2 to 6.

## 2. Rules learned from the six preparation parts

The preparation parts P1 to P6 each took four to seven review rounds and converged only once their scope was cut; P9 and
P7 then started from cut first versions. Every pull request here starts from these rules, and its reviewer checks them:

1. **A stated bound for everything**: counts, sizes, lengths, times, rates, queue depths, retries. A bound is a number
   in the pull request's documentation and a test at the limit. "Small" is not a bound.
2. **One decision in one place**: who may use an account is decided by one function, which device may be called by one
   function, which address a request may go to by the helper's entry point. Nothing re-decides it on another path.
3. **Nothing stale after a wait**: code that awaited (a refresh, a token exchange, a reconnect, a ring) reads the state
   again before it acts on it (the account still exists and has the same revision; the call is still ringing; the flow
   is still the current one).
4. **Nothing new on the turn path**: no account lookup that touches the network, no token refresh, no socket read
   inside a context provider or before the first token. A tool call may do network work within its own time limit.
   A latency claim needs `TurnTrace` numbers (and for calls, `CallTrace` numbers, §9).
5. **Secrets never in text**: tokens, refresh tokens, client secrets, passwords, authorization codes, PKCE verifiers,
   `state` values and the address the owner pastes back never reach a log line, an error, a status, a Health issue, a
   tool result, a spoken line, a stored row or a page. `checkModule`'s `secret` check and the kit's `expectNoSecrets`
   cover module code; the account code gets the same test.
6. **What is left out is named**, in the pull request and in the module's `docs/modules/<id>.md`.
7. **No library that makes its own requests** (docs/MODULES.md §12): every outgoing request goes through `@pva/net`,
   so the address guard holds and the kit's offline network sees it.
8. **A large parse is off the main thread** (docs/MODULES.md §15, `offThread`): an answer that can be over 64 KiB is
   parsed in a worker, or its main-thread cost at the largest legal size is measured and stated.

## 3. The network helper: request kinds, streams, sockets

**What it is for.** Every module request goes through `@pva/net`, which guards addresses, sizes and times. It can GET
and HEAD anything public and POST JSON once to an address the owner typed. The deferred modules need more: OAuth token
endpoints take a form body, CalDAV speaks `PROPFIND`, `REPORT`, `PUT` and `DELETE` with XML and iCalendar bodies, MCP
servers may answer with a stream of server-sent events, and Home Assistant pushes changes over a WebSocket.

### 3.1 What exists and what is missing

- `packages/net/src/SafeFetch.ts`: `safeFetch` is GET and HEAD only, public addresses, ports 80 and 443, in its type and
  at run time. `fetchOwnerConfiguredLan` adds private addresses, local names, other ports, loopback only as typed
  (`typedLoopback`), and `method: "POST", body: { json }` (at most 128 KiB, sent once, no redirect followed). The
  connector's `ConnectRequest.method` is `"GET" | "HEAD" | "POST"`. The whole body is read into `SafeResponse.body`
  (at most `maxBytes`, 2 MiB by default) before the caller sees it. `upgrade` and `connection` are forbidden request
  headers. So: no form body, no other method, no stream, no WebSocket.
- **This corrects MODULES-PLAN "Order from here" item 5**, which says the helper fetches with GET and HEAD only. The
  POST and typed loopback were added on the scaffold branch (MODULES-STATUS, "Fixes to P1 to P6 code").
- Already there to use: the address classifier (`Address.ts`), the node connector that dials the checked address with
  the TLS name from the URL (`makeNodeConnector`, with an optional CA for an owner's LAN), the kit's offline network
  (`makeOfflineNet`), `ws@8.23.0` in the workspace (the server's own socket, `apps/assistant/src/serve/http.ts`), and
  Effect 4.1.4's `HttpClient` service (`effect/http/HttpClient`) and `effect/ai/McpClient` (§5.1).

### 3.2 First version

**Pull request N1, request kinds** (`t3/modules-12-net-requests`):

- `fetchOwnerConfiguredLan` gains `body: { form: Record<string, string> }` for POST (URL-encoded, at most 16 KiB), and
  the methods `PUT`, `DELETE`, `PROPFIND` and `REPORT`, with `body: { text, contentType }` where `contentType` is one of
  `application/xml`, `text/xml`, `text/calendar` (charset UTF-8 added by the helper), within `maxRequestBytes`. A
  `depth` request header is allowed with the values `0` and `1` only. Every method but GET and HEAD follows the POST's
  rules: sent once, to one server, no redirect followed (the existing `post-redirect` refusal, name kept, covers them
  all), the next address only when nothing was sent.
- A new entry point, **`fetchFixedPublic(url, …)`**, for addresses written in code (Google's token, revoke and API
  endpoints): `https` only, public addresses only (the `safeFetch` address rules), port 443, GET, HEAD and POST with a
  JSON or form body, no redirect followed. It is never given a URL from a model or from an outside answer.
- A response preset `contentTypes.xml` (`application/xml`, `text/xml`) and acceptance of status 207 like any 2xx.
- The three entry points and what each may be given are one table in `packages/net/README.md` and in
  docs/MODULES.md §12; that table is the decision (§2 rule 2).
- Left out: other methods, multipart bodies, request bodies that stream, redirects for anything but GET and HEAD.

**Pull request N2, streams and sockets** (`t3/modules-13-net-streams`), based on N1:

- **`streamOwnerConfigured(url, options)`**: the checks and request kinds of `fetchOwnerConfiguredLan`; the response
  type is checked before the stream starts; the body is a pulled `Stream<Uint8Array, SafeFetchError>` inside a scope
  (closing it aborts the request). Bounds: `maxBytes` for the whole response (default 1 MiB, at most 16 MiB), `idleMs`
  between chunks (default 30 s, at most 120 s), `lifetimeMs` for the whole response (default 60 s, at most 10 min), and
  `timeoutMs` for the response head as today. Decompression and its limits as today.
- **`netHttpClient(options)`**: an Effect `HttpClient` built with `HttpClient.make` over `streamOwnerConfigured`, for
  libraries that take one (§5.1). It sends GET, POST with a text or JSON body, and DELETE, to the one base address it
  was made for (any other origin is refused before a lookup); anything else fails as an `HttpClientError`.
- **`openOwnerConfiguredSocket(url, options)`**: a WebSocket client, `wss:` to any address the owner typed, `ws:` only
  to a LAN or typed loopback address. The host is resolved and checked as for a request, the socket is opened to the
  checked address with the TLS name from the URL, and the handshake follows no redirect. Built on `ws` (already in the
  workspace) with a lookup that answers the checked address; whether `ws` passes that lookup to Node's request in its
  current version is checked in the pull request, and if it does not, the socket is made with `createConnection` on
  the connector. Bounds: handshake 5 s; one message at most `maxMessageBytes` (default 1 MiB, at most 4 MiB, the
  `ws` `maxPayload`); incoming messages a pulled stream with at most 256 waiting, beyond which the socket is closed with
  `overflow` (never an unbounded buffer); outgoing at most 64 messages or 256 KiB waiting, beyond which the send fails;
  a ping every 30 s and close after 2 missed pongs; close when the scope closes. Reconnecting is the caller's, with a
  back-off the caller states.
- Kit: `makeOfflineNet` gains streamed fixtures (chunks, an idle stall) and a scripted WebSocket peer, in memory, so a
  module's test needs no network.
- Left out: WebSocket to a URL a model chose, `wss` with client certificates, server-sent events as a parsed type (the
  consumer parses; Effect has `effect/encoding/Sse`), HTTP/2.

### 3.3 Risks and decisions

- **Q1. May a request carrying an account credential go over plain `http`?** Recommended: only to an address the owner
  typed that is on the LAN or typed loopback, as the Home Assistant module does today with its token; never to a public
  address, and `fetchFixedPublic` is `https` only. The account card says "sent unencrypted on your network" for such
  an address. Why: refusing LAN `http` would break the common Home Assistant, Radicale and Nextcloud setups, and the
  home network is already the trust boundary for device ids (MODULES-PLAN §2 row 7).
- Risk: the helper's time limits run on the wall clock, not the kit's test clock (reported in the smart-home fix
  round). Streams make that more visible. N2 takes the clock as a dependency for `idleMs` and `lifetimeMs`, so a test
  can step them.

### 3.4 The Home Assistant module on a WebSocket

**Pull request M6** (`t3/module-smart-home-websocket`), based on N2 and the smart-home branch. Today
`packages/module-home-assistant/src/module.ts` reads the house every 60 s (`DEFAULT_REFRESH_MS`) with template POSTs,
and the `HomeAssistant` transport in `src/service.ts` says "in this version the provider polls". This PR replaces the
poll with Home Assistant's WebSocket API (authenticate with the token, read the states, the area and entity registries
and what is exposed to Assist, subscribe to changes), keeps the same contract (`packages/module-contracts/src/homeAssistant.ts`:
a fresh snapshot after a reconnect, never read as changes), and keeps the module's owner-facing settings. Bounds:
the supported house stays 2,000 entities; the first snapshot is parsed off the main thread when it is over 64 KiB;
changes are applied in batches at most every 250 ms; reconnect back-off from 1 s to 60 s; the main-thread cost of the
largest batch is measured as the poll's was (3.5 to 4.0 ms). Left out: everything the module's documentation lists as
later (locks, watches, cameras, energy, hiding single entities). Which WebSocket commands Home Assistant offers for the exposure list and
the registries in its current version is checked against a real Home Assistant before the PR is written; it is not
known from this repository. This also retires the open point that the module's templates were never run against a
real Home Assistant (MODULES-STATUS).

### 3.5 Review and tests

A reviewer can reproduce everything with the kit and the loopback tests that `packages/net/test/` already uses (a real
socket on 127.0.0.1): each new method and body at its limit and one byte over; a redirect answered to each non-GET
method; a stream that stalls (idle), that never ends (lifetime), that grows past `maxBytes`; a socket peer that sends
one message over the limit, floods past 256 waiting, stops answering pings; `netHttpClient` refusing another origin;
no header value or credential in any error. Only a real Home Assistant can show M6's command names and the size of
a real first snapshot.

## 4. Accounts and OAuth (the rest of P8)

**What it is for.** A typed, tested link to an outside account (a CalDAV server, an MCP server's token, a Google
account, a T3 Code sign-in), kept in the vault, owned by the household or by one person, used by the modules the owner
allows. Today every credential is a secret field of one module.

**The name.** MODULES-PLAN calls these "connections" and plans `ctx.connections`. In the code a connection is already
the browser tab a request came in on: `CurrentTurn.connection` is a `ConnectionRef` (`packages/core/src/TurnContext.ts`),
and the host view counts a device's `connections` (`packages/core/src/ModuleApi.ts`). **This plan calls them
accounts**: `ctx.accounts`, account types, account records (Q2).

### 4.1 What exists and what is missing

- **The vault**, `apps/assistant/src/serve/Vault.ts`: one encrypted file (scrypt, AES-256-GCM, atomic writes,
  serialised), holding `VaultSecrets { modules, assistant }`. No section for accounts. It locks at every restart unless
  `PVA_VAULT_PASSWORD` is set; deployment's `systemd-creds` stays out of scope (MODULES-PLAN §7).
- **Secrets in modules**, docs/MODULES.md §8: a `Setting.secret` field per module, one value each. A `records` item
  cannot hold a secret, so a module cannot have one credential per entry (one per CalDAV server, one per MCP server).
- **The settings model and admin forms** (P3): `records`, `action` buttons with a "Test" press (8 s, 4 at once per
  module), `info` values, size budgets. Accounts reuse the form renderer for their own page.
- **Module routes** (P3), `apps/assistant/src/serve/moduleRoutes.ts`: the `admin` guard is an `Authorization: Bearer`
  header, so a browser that lands on a redirect cannot pass it. An OAuth callback would have to be a `public` GET
  route. The first version needs no callback (Q3), so this is noted, not used.
- **The program registry** (`apps/assistant/src/requirements.ts`): one registry in the app that starts empty and grows
  with the module that needs an entry. The account-type registry follows the same pattern.
- **The scheduler** (P6), for one maintenance job; **Health** (P1) for account issues; **People** and
  `Privacy.mayReveal` (P5) for personal content; `CurrentTurn` and job origins (P1, P6) for who is asking.
- Missing: everything else: types, records, credentials, flows, `ctx.accounts`, the admin page, a kit double. The
  kit's only "connection" is the tab reference (`testConnectionOf` in `packages/core/src/ModuleTestKit.ts`), not the
  fake account P11 planned.

### 4.2 The design

- **Account types** are one registry in the app (`apps/assistant/src/accounts.ts`), each with an id, a label, its
  credential kind and fields, and for OAuth its endpoints, scopes and test call. A module declares what it uses on its
  manifest: `accounts: [{ type, scopes?, why }]`; it can resolve only those types. A type is added by the PR of the
  first module that needs it (CalDAV adds `caldav`, google adds `google`). Why one registry and not types declared by
  modules: the calendar module reads a Google account that the google module also reads; neither should own it.
- **An account record** is a row of a household settings section "Accounts": id, type, label (at most 60 characters),
  owner (`household` or a Members id), the address the owner typed (for types that have one), the modules allowed to
  use it, and for a personal account the devices it may be used from (at most 20). At most 30 accounts. Its status is
  derived, not saved: `ok`, `locked` (vault locked), `needs-sign-in` (refused or expired), `expiring` (a sign-in that
  cannot be refreshed ends within 3 days), `failed` (the last test failed, with a short reason code).
- **The credential** is in the vault under a new section `accounts[id]`: `{ token }`, `{ username, password }`, or for
  OAuth `{ refreshToken?, accessToken?, expiresAt?, clientId?, clientSecret? }`. An access token is kept only in memory
  when a refresh token exists; when the provider gives none (§8: T3 Code), the access token is the credential and is
  kept in the vault. A client the owner registered (Google) has its id in settings and its secret in the vault, once
  per type.
- **Writing is whole or not at all**: a new account's credential is written to the vault first, then its record; a
  vault entry with no record is removed at start. Unlinking removes the record, then the credential. A rotated refresh
  token is saved before the new access token is used, and only if the account still has the credential revision it
  had when the refresh started (§2 rule 3).
- **`ctx.accounts.resolve(type, { scopes? })`** is the one decision of who may use an account (§2 rule 2). For a call
  in a turn: the module must be on the account's module list; a personal account is used only when the turn's person
  (the device's default person, MODULES-PLAN §2 row 1) is its owner **and** the turn's device is on its device list;
  otherwise a household account of the type; otherwise a typed refusal (`none`, `locked`, `needs-sign-in`, `not-here`,
  `missing-scope`) with a sentence in English and Dutch. For code outside a turn (a job, a `shared` fiber):
  `ctx.accounts.byId(id)`, only for an account whose module list names the module; what it reads is tagged with the
  account's owner and goes through `Privacy.mayReveal` wherever it is shown or spoken. The handle gives `token()` or
  `basic()`, the address and the owner; never the refresh token. A module looks an account up at each use and keeps no
  handle across a wait.
- **Nothing on the turn path**: records and status are in memory; `token()` returns at once when the access token is
  valid, and otherwise waits for the one refresh in flight within the calling tool's own time limit.

### 4.3 The pull requests

**A1, accounts with pasted credentials** (`t3/modules-14-accounts`), based on the top of the preparation stack when it
starts (P8's first version if it is there, else P10). The type registry with no OAuth; the record section; the vault's
`accounts` section (an old vault without it reads as empty); `ctx.accounts` (`resolve`, `byId`, `token`, `basic`);
credential kinds `token` and `basic`; the admin page "Accounts" (add, edit the label and the lists, test, remove; the
credential field write-only); the status and its Health issues; the manifest field and the host's check that a module
resolves only what it declared; the kit double (`makeTestAccounts`: an account of any type and owner, scripted
`token()` results including `locked` and `needs-sign-in`) and a `checkModule` rule that a declared account type
exists. No account type is registered by A1 itself except a `test` type the kit uses. Left out: OAuth, moving existing
module secret fields (Home Assistant's token) to accounts, narrowing by assistant.

**A2, OAuth with a client the owner registered** (`t3/modules-15-oauth`), based on A1 and N1:

- **One flow: authorization code with PKCE (S256) and a loopback redirect, finished by pasting back.** The owner
  presses "Sign in" on the account; the server makes a flow with a random `state` (32 bytes), a PKCE verifier, the
  type's loopback redirect address and an expiry of 10 minutes, and shows the authorization address. The owner signs in
  wherever they are; the browser ends on the loopback address, which loads nothing; the owner pastes that address
  (at most 4 KiB) into the page. The server checks the `state` (constant-time), that the flow is still the current
  one and not expired, and an `iss` parameter when the provider sends one; it exchanges the code (a form POST through
  `fetchFixedPublic`, answer at most 16 KiB, 10 s) and saves. One flow per account at a time; a new one replaces the
  old.
- **Refresh**: single-flight per account, started by the account service ahead of expiry (at four fifths of the
  access token's life), so a tool rarely waits; a rotated refresh token is saved at once (§4.2). An `invalid_grant`
  answer sets `needs-sign-in` and a Health issue; network failures are retried with back-off up to 3 times, then the
  next refresh is planned.
- **Maintenance**: the account service owns one job planned for the next thing due across all accounts (a refresh, a
  keep-alive refresh of an account idle for 30 days, an `expiring` warning) and one daily safety net, the shape P9
  settled on after its first review; never one job per account.
- **Unlink** revokes at the provider when the type has a revoke endpoint (best effort, once), then removes.
- The first OAuth type, `google`, is added by google's PR (§7) with its endpoints and scopes; A2 tests against a fake
  provider.
- Left out: the device authorization grant, a callback route, a hosted redirect relay, other client authentication
  than a client secret in the body.

**A3, OAuth for an MCP server** (`t3/modules-16-oauth-mcp`), based on A2 and N2. For servers that publish where to sign
in (MCP's authorization rules; RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata, RFC 7591
dynamic client registration, RFC 8707 `resource`):

- The owner types the server's address. The server reads the protected-resource metadata (from the address in a 401
  answer's `WWW-Authenticate`, or the well-known path), then the authorization server's metadata, registers a client
  (a JSON POST, public client, the loopback redirect), and runs A2's flow with the `resource` parameter.
- **Bound: every address discovered must be on the origin the owner typed.** An authorization server elsewhere (a
  GitHub sign-in in front of an MCP server) is refused with that reason. This is what keeps a server's answer from
  sending the owner's sign-in to an address nobody typed.
- PKCE S256 required (a server that does not list it is refused); registration answers at most 16 KiB; a client id is
  kept in the vault with the account and re-registered only on a new sign-in.
- A server that grants no refresh token: the access token is the credential; `expiring` 3 days before `expiresAt`.
- Left out: Client ID Metadata Documents (they need a public address for our client's metadata, which this server does
  not have), authorization servers on another origin, step-up scopes.

### 4.4 Risks and decisions

- **Q2. "Accounts" instead of "connections"?** Recommended: yes, for the code collision above. One name in the code,
  the admin page and the documents.
- **Q3. Which OAuth flows first?** Recommended: only authorization code with PKCE and paste-back. Why: no first
  consumer can use the device grant (Google refuses it for Gmail and Calendar scopes, per google.md §5.2; T3 Code's
  metadata lists only `authorization_code`, per t3-code.md §1); a callback route needs a `public` route that a browser
  from any site can reach (the admin guard is a bearer header) and a real HTTPS name; paste-back works from a phone and
  from the server alike. A callback on the server's own HTTPS name can come later as a second way to finish the same
  flow.
- **Q4. Where does a person's account live, and who may use it from which device?** Recommended: as in §4.2: in the
  vault, owned by the person, used only by modules the owner ticked, only in turns whose device's default person is
  the owner and only on devices the owner listed (empty by default), and by jobs only through `byId` with the owner's
  tag on everything read. **What this does not protect against**: device ids are claimed by the page, not
  authenticated (MODULES-PLAN §2 row 7). Anyone on the home network who opens the voice page as a listed device can
  hear what that person's account can be asked for. The owner must accept that before any personal account is linked;
  if not, personal accounts wait for authenticated devices, and only household accounts exist.
- **Q5. Does anything here need a `message`-class action, and may one exist before confirmation is repaired?**
  Recommended: no and no. Nothing in this plan sends mail, starts or messages a T3 thread, answers a question in T3,
  calls an outward MCP tool or sends a call link. Each stays out until core's confirmation is repaired and extended
  (MODULES-PLAN §2 row 6, §7). Module-made confirmations (a draft and a later "send") are not used: investigation §11
  row 14 recommends against them, and they would be a second confirmation path to review.
- **Q6. The vault is locked after a restart.** Recommended: accept it: accounts are `locked` until the owner unlocks,
  modules say so, and the maintenance job waits. Unattended unlocking is deployment's (MODULES-PLAN §7).
- Risk: a rotated refresh token lost to a crash between the provider's answer and the vault write leaves the account
  needing a new sign-in. The window is one atomic file write; it is stated, not engineered away.
- Risk: providers' present behaviour (Google's 7-day refresh tokens for apps left in Testing, the 6-month idle expiry,
  T3 Code's 30-day sign-in) is from the research, not checked here. Each type's PR checks it against the real service
  and writes what it found into the type's documentation.

### 4.5 Review and tests

Reproducible with fakes: the kit double for modules; for the account code itself, a fake provider on the offline
network (token endpoint, revoke, metadata, registration) and a vault on a temporary path. A reviewer must be able to
run: a flow with a wrong, reused or expired `state`; a pasted address over 4 KiB or with no code; two refreshes at
once (one request); a rotation followed by a crash before the vault write (the old token still saved); an unlink
during a refresh (nothing written back); `invalid_grant`; a locked vault; a personal account asked for from an
unlisted device and by a person who is not its owner; discovery that points to another origin; a registration answer
over the limit; no secret or code in any output. Only a real provider shows its consent screen, its redirect rules
(whether any loopback port is accepted) and its token lifetimes.

## 5. mcp-client

**What it is for.** The owner adds HTTP MCP servers and ticks which of their tools an assistant may use; those tools
join the assistant's tools. It is the way to reach services this project will not build natively, at the cost of trust
and prompt size.

### 5.1 What exists and what is missing

- **The client library**: Effect 4.1.4 ships `effect/ai/McpClient` (experimental since 4.0.6): Streamable HTTP with
  JSON or server-sent-event answers over the `HttpClient` service, protocol adapters for `2025-11-25` and
  `2026-07-28` among others, tool listing with page and item limits, `maxMessageBytes`. Not included: OAuth,
  interactive server requests, subscriptions, retries. It closes a legacy session with a DELETE whose failure it
  ignores. `effect/ai/McpTest` runs a server in memory for tests.
- **This differs from the research and from MODULES-PLAN Appendix A**, which name `@modelcontextprotocol/client` (or
  `@modelcontextprotocol/sdk`). That library makes its own requests with `fetch`, which docs/MODULES.md §12 forbids and
  the kit's offline network cannot see. With `netHttpClient` (§3.2) Effect's client goes through `@pva/net`. The code
  wins: Effect's client, no MCP SDK in the module.
- Effect's client picks one protocol revision per transport; trying `2026-07-28` and falling back to `2025-11-25` is
  the module's code.
- **Settings**: P3's forms; nested configuration as validated JSON in a text field (MODULES-PLAN §3.3). A server's token
  cannot be a module secret field (one value per field; none in a `records` item): it is an account (A1, type
  `mcp-token`).
- **Dynamic tools**: P1's `requestRestart` lets a module whose tool list changed be started again; tools are built in
  `start` from what `shared` has read.
- **Risk**: an explicit `risk` on a tool with `speculative: false` is allowed by the gateway (docs/MODULES.md §4).

### 5.2 First version (pull request M1, `t3/module-mcp`, based on N2 and A1)

- At most 5 servers, each `{ id, prefix, url (owner typed), account? (an `mcp-token` account, sent as a bearer
  header), revision: auto | 2025-11-25 | 2026-07-28, timeoutMs (default 8 s, at most 30 s), tools }`, where `tools`
  is validated JSON: per server tool `{ name, spokenName?, risk: "read" }`. Nothing is offered until it is ticked.
- **Read only**: the only risk an owner can give an MCP tool in this version is `read`, and it is never speculative.
  `change` waits for a later PR and an owner decision; `message`, `money` and `security` wait for confirmation and
  authenticated devices.
- **Pinned definitions**: when the owner ticks a tool, the module stores a hash of its name, description and input
  schema. A later `tools/list` that differs for that tool withdraws it (not offered, Health names it) until the owner
  ticks it again. Descriptions over 1,024 characters are cut. The pins are rows of one household collection in the
  module's store (at most 50, one per ticked tool, values under 400 characters).
- **Bounds**: at most 10 MCP tools per assistant across servers (more is a configuration error that names them); tool
  names `<prefix>_<tool>`, at most 64 characters of `[a-z0-9_]`, unique; `tools/list` at most 5 pages and 200 tools per
  server; one message at most 256 KiB (`maxMessageBytes`), with the main-thread cost of parsing the largest legal
  message measured (the parse is inside Effect's client) and the limit lowered if it is over 10 ms; results cut to
  6,000 characters and passed to the model marked as outside content, never as instructions; arguments at most 8 KiB.
- The server list is read in `shared` at start and on "Check again" (time limit 10 s per server), never on a turn; a
  changed list asks for a restart at most once a minute. A server that fails is `failed` on the Health page and its
  tools are not offered; the others work.
- Barge-in interrupts the call; the request is abandoned (Effect's client closes the stream).
- Left out: stdio servers, OAuth servers (M8), `change` tools, server tasks, elicitation, sampling, roots, MCP Apps,
  `find_tool` and loading on demand, the `Mcp` service for other modules (not shared, per the scaffold's decision;
  §8 does not need it), sending turn context to a server.

**M8, OAuth servers** (`t3/module-mcp-oauth`), based on M1 and A3: a server's account may be an `mcp-oauth` account;
nothing else changes.

### 5.3 Risks and decisions

- **Q7. What is the security position of an MCP server's tools?** Recommended: a server is untrusted whoever runs it;
  its annotations are ignored; only tools the owner ticks are offered, only as `read`, never run early, with pinned
  definitions and results marked as outside content. The owner's tick is the claim that a tool only reads; the module
  cannot check it, and its documentation says so. Why: a tool that is wrongly ticked as `read` can still change things
  at the server; the bound is that the owner chose it by name, and the pin stops a server from changing what was
  chosen.
- **Q8. Should `change` tools come next?** Recommended: only after the read-only version has run for a while, as a
  separate PR, because it is the first time an outside party's code changes things on a turn the gateway allowed as
  `change`.
- Risk: Effect's MCP client is experimental; its API may change in a minor version. The module pins the Effect version
  it was tested with and keeps the client behind one file.

### 5.4 Review and tests

With `effect/ai/McpTest` and the offline network's streamed fixtures: both revisions and the fallback; a JSON answer
and an event stream; a stalled stream (the call's timeout); a message one byte over the limit; a changed definition
(the tool withdrawn); 11 ticked tools; a name collision; a result over 6,000 characters; a server that fails at start.
Only real servers (the research's starter list) show which revision they speak and how large their definitions are.

## 6. CalDAV in the calendar module

**What it is for.** Calendars on a CalDAV server (Nextcloud, Radicale, Baïkal, Fastmail and others), including ones
on the home network, read like the ICS links the module reads today, and later written to.

### 6.1 What exists and what is missing

- `packages/module-calendar` (`t3/module-calendar`): ICS links only, read through `safeFetch` (public addresses only),
  parsed and expanded with `ical.js` in an `offThread` task (`src/ics.task.ts`), cached by a refresh job, with privacy
  per calendar owner. `src/provider.ts` defines a `CalendarProvider` interface inside the package; "CalDAV and Google
  are later providers of the same interface". `docs/modules/calendar.md` lists what was left out: CalDAV,
  `calendar_add` with undo, calendars on the home network, a Test button.
- **This differs from MODULES-PLAN §5.2**, which makes `CalendarProvider` a contribution other modules provide. The
  scaffold kept it inside the calendar package (no other module provides a calendar in that wave). This plan keeps it
  there: CalDAV and Google become providers in the calendar module (§7).
- **This differs from the research and Appendix A**, which name `tsdav`: it makes its own requests. CalDAV here is a
  handful of hand-written requests on `@pva/net` (N1's `PROPFIND` and `REPORT`) with the XML answer parsed in the
  same worker task that already expands events.
- Missing: the methods (N1), a credential per server (A1), an XML parser in the worker.

### 6.2 First version

**M2, read** (`t3/module-calendar-caldav`, based on N1, A1 and the calendar branch):

- A `caldav` account type (A1's `basic` kind: address, user name, app password). A calendar source names a `caldav`
  account and the calendar's collection address on that account's origin; the module checks that it is on that origin.
- The provider sends one `REPORT` `calendar-query` with a time range for the cache's window, through
  `fetchOwnerConfiguredLan` (so a LAN server works), and reads the `getetag` and `calendar-data` of each answer item in
  the worker; the existing expansion, limits and privacy rules then apply unchanged. A conditional read uses the
  collection's `getctag` or sync token only if the server offers one; otherwise a full read every refresh.
- A "Test" button: one `PROPFIND` (depth 0) on the collection, which says whether it is a calendar and its name.
- Bounds: the existing limits of the ICS reader (answer at most 2 MiB, events and series limits); at most 10 CalDAV
  calendars; no redirect followed, and an `href` in an answer on another origin is refused.
- Left out: discovery from a server address through `/.well-known/caldav` and the principal (the owner pastes the
  collection's address), calendars whose data live on another host (whether iCloud works this way is not known from
  this repository and is checked against it in the PR), VTODO, writing.

**M3, adding events** (`t3/module-calendar-add`, based on M2): `calendar_add` for single events to one CalDAV calendar
the owner marks writable, with `PUT` and `If-None-Match: *`, and undo of the module's own last add with `DELETE` and
`If-Match`; a repeating event is refused (MODULES-PLAN §2 row 6). Risk class `change`. Left out: change and delete of
other events, attendees (a `message` risk).

### 6.3 Risks and decisions

- **Q9. May the assistant add events without asking?** Recommended: yes, for single events on a calendar the owner
  marked writable, because adding is `change`, undo exists, and confirmation is off; never for repeating events.
- Risk: servers differ in how they answer `calendar-query` (time-range filtering, expansion). The module never asks the
  server to expand; it expands locally, as it does for ICS.

### 6.4 Review and tests

Fixtures of `REPORT` and `PROPFIND` answers (multistatus with several items, an item with no data, an `href` on another
origin, an answer over the limit, XML built to make a parser loop), the worker's limits, a `PUT` that fails after it
was sent (said as "may or may not have"), undo after the event changed (refused). Only real servers show their
differences; at least one (Radicale is the easiest to run) is tried before the PR is opened, and the PR says which.

## 7. google

**What it is for.** The owner's wish: read mail and calendars from a Google account by voice. Mail is useful as a
summary and a search, not as a reader of whole messages (google.md §2).

### 7.1 What exists and what is missing

- Nothing Google-specific exists. Plain HTTPS JSON reads are possible today (`safeFetch` with an `Authorization`
  header), but the token exchange needs a form POST to a fixed public address (N1's `fetchFixedPublic`) and a person's
  account needs A1 and A2.
- `Privacy.mayReveal` and the personal tag (P5, MODULES-PLAN §2 row 8), the briefing's `BriefingSection` contract
  (P11), `offThread` for message bodies, the calendar's provider interface (§6.1).
- **This differs from the research**, which proposes `packages/connection-google` and, as a first version without
  foundations, module secret fields and a CLI sign-in command. Accounts replace both.

### 7.2 First version

**M4, mail, read only** (`t3/module-google`, based on A2):

- The `google` account type: the owner's own client (a Google Cloud project with a client of type Desktop app; id in
  settings, secret in the vault), A2's flow, scopes requested per capability (`gmail.readonly` for mail,
  `calendar.events.readonly` and `calendar.calendarlist.readonly` for calendars).
- Tools `mail_overview`, `mail_search`, `mail_read` (`gist` or body, at most 1,500 characters), all `read`, all
  `personal` with the account's owner; senders by name, never addresses read aloud; results marked as outside content.
  `mail_overview` is also a typed action with a template sentence.
- Live calls only: a list of message ids, then at most 10 metadata reads, at most 4 at once, within the tool's time
  limit; a body is fetched only for `mail_read` (answer at most 1 MiB) and turned into plain text in a worker.
- A mail briefing section (counts and senders), personal, kept only for the asking person.
- Bounds: the above, plus a search query at most 200 characters; nothing of mail is stored.
- Left out: send, drafts, archive and mark read (`gmail.modify`), contacts, Drive, Tasks, the mail cache and sync job,
  Gmail push, "important mail" notifications, a `list` presentation of the overview (P10 has the kind; a small
  follow-up once the spoken version has been used).

**M5, Google calendars** (`t3/module-calendar-google`, based on A2, M4 for the account type, and M2): a Google provider
in the calendar module, reading events with Google expanding repeats, through `byId` on the calendar's `google` account
from the refresh job, privacy by the account's owner. Left out: adding events.

### 7.3 Risks and decisions

- **Q10. Whose Google accounts, and on which devices?** Recommended: the owner's own account first, owned by the owner
  as a person, used by google and calendar only, from devices the owner lists (Q4). A partner's account works the same
  way once Q4 is accepted.
- **Q11. May mail headers and, on request, bodies go to the hosted language model?** Recommended: headers and snippets
  yes, a body only when the person asks about one message. The alternative (no mail to the hosted model) means mail
  tools only on an assistant with a local model. This is the owner's call (google.md Q4).
- **Q12. Setup**: the owner creates the Cloud project, sets it "In production" (Testing gives refresh tokens that
  expire after 7 days, per google.md §5.2) and accepts the "unverified app" warning. Recommended: the account page
  shows these steps as a checklist; on a Workspace account, an Internal app avoids the warning. To check against
  Google before M4: whether a Desktop client accepts any loopback port, and the current refresh-token rules.
- Risk: mail is untrusted text that can try to steer the model; results are marked and no tool that sends exists.

### 7.4 Review and tests

Fixtures of Gmail's list, metadata and message answers (multipart, HTML only, very long, a quoted thread) and the token
endpoint; the privacy reduction on a shared device; a person who is not the owner; `needs-sign-in` mid-call. Only a
real account shows the consent screen, the warning and real messages; the PR author tries one account and says so.

## 8. t3-code

**What it is for.** The owner's coding threads in T3 Code, by voice: what they are doing, what one said, which pull
requests they opened. T3 Code offers an MCP endpoint with OAuth for outside agents (t3-code.md §1).

### 8.1 What exists and what is missing

- The MCP client (Effect's, over `netHttpClient`, §5.1) and OAuth for an MCP server (A3). No dependency on the
  mcp-client module: **this differs from MODULES-PLAN §5.1 row 15** ("after 22", on the `Mcp` service). The scaffold
  did not share `Mcp`, and with Effect's client in the workspace each module can hold its own client; the module keeps
  voice-shaped tools of its own, which the research recommends.
- T3 Code's tool names, scopes, grant ceilings and 30-day sign-in are from the research's reading of T3 Code's
  documentation and source at release v0.1.10; they are checked against the running version before the PR.

### 8.2 First version (pull request M7, `t3/module-t3-code`, based on A3 and N2)

- A `t3-code` account type (A3, scope for reading only), the T3 address the owner typed, `https` or typed loopback only
  (T3's own documentation says agents sign in only over those).
- Tools `t3_overview` (at most 8 threads), `t3_thread_status` (the last message cut to 1,500 characters),
  `t3_pull_requests`, `t3_projects`; all `read`, all `personal` with the account's owner; thread text marked as outside
  content; file paths shortened, ids never spoken. A typed action for "what are my threads doing".
- The "coding" assistant template.
- Left out: starting, messaging, stopping or answering threads (they run code as the owner: `security` at least, and
  they need confirmation), watches and "tell me when done", CI status, a context line (it would be a cache of personal
  content that goes stale; the calendar's ambient line was cut for the same reason), presentations.

### 8.3 Risks and decisions

- **Q13. At which ceiling does the owner approve the assistant in T3 Code?** Recommended: Read only, the only ceiling
  this version needs. A leaked token then cannot start work.
- **Q14. Is a new sign-in every 30 days acceptable?** Recommended: yes; the account shows `expiring` 3 days ahead.
  Minting sessions through T3's command-line tool would give full access and work only on the same machine.

### 8.4 Review and tests

A fake T3 server on the offline network (metadata, registration, token, the four MCP tools) built with Effect's MCP
server; an expired sign-in; a thread title that tries to give the model instructions. Only a real T3 Code shows the
approval page and the tools' present shapes.

## 9. calls and intercom

**What it is for.** Two-way audio between two of the house's browser devices: "call the kitchen", answer, hang up.
Stage 1 of the research (calls-and-intercom.md §5.6): audio relayed by the server over the existing socket.

### 9.1 What exists and what is missing

- **Audio**: `packages/protocol/src/frames.ts` has frame kinds 1 (microphone) and 2 (reply), an 8-byte header with a
  u32 field. The research's frame kind 3 with a call-leg id fits it.
- **The `call` guard does not exist.** P7's first version built one window, `ringing`
  (`packages/core/src/PhraseDecision.ts`: "the host's only window"); no module windows, no guards.
- **Notifications** (P9, `docs/NOTIFICATIONS.md`): `ring` priority, actions with handlers, the ringing window's button
  phrases, do not disturb for the house. **A notification's target is `origin` or `everywhere` only**: a call needs to
  ring one named device. Every button label is accepted without the wake phrase while it rings.
- **Devices** (P5): `place.acceptsFromOthers` exists (`packages/core/src/Devices.ts`) and is used for screens; P9 left
  acceptance settings out.
- **Speech** (P9): `ctx.speech.say` to a device or room. **Presentation** (P10): a card on the callee.
- MODULES-PLAN §5.1 row 23 says calls change only the protocol, the server and the voice page. In the code they also
  need the phrase decision and the notification service. This plan splits that work.

### 9.2 First version

**C1, the call guard and device targets** (`t3/modules-17-call-guard`, based on the top of the stack with P7, P9 and
P10):

- A `call` guard in the phrase decision, set and cleared by the host's call service (C2), not a module window: while a
  device is in a call, an utterance without the wake phrase is dropped; one with the wake phrase is taken only by the
  host's controls and the call's phrases ("hang up", "mute"), and never becomes a model turn; the ringing window needs
  the wake phrase; no follow-up window and no assistant without a wake phrase on that device.
- `ctx.notify.send` gains the target `{ device }` (one named device).
- A notification action gains `spoken: "wake"`: its label is accepted only after the wake phrase or as a tap.
- Left out: module windows, `capture`, the `media` guard, `audible`.

**C2, the call relay** (`t3/modules-18-call-relay`, based on C1): a host service in the server that holds at most 4
calls, each between two devices; each leg bound to the one connection that started or answered it, and every action
and frame checked against that binding; call audio never sent to other tabs of the same device; a takeover or a
disconnect ends the leg. Frame kind 3 with the leg id; `call.*` messages; on the voice page a second player queue for
call audio and an overlay with hang up and mute. Bounds: one call per device; ring 30 s; a call at most 60 minutes;
at most 60 frames a second per leg (more are dropped and counted); a restart ends every call. A `CallTrace` records
ring time, time to first remote frame and the server's relay delay per frame. Left out: voice nodes, video, WebRTC,
groups, recording.

**C3, the module** (`t3/module-calls`, based on C2): `call_start` by device or room name, `call_hang_up`,
`call_status`, all `change`; phrase commands "call the …" and "hang up"; the ring as a `ring` notification on the callee
with `answer` (`spoken: "wake"`) and `decline`; do not disturb refuses the call; a missed call tells the caller. A
device accepts calls only when its "accepts calls" setting (the module's, off by default) and `acceptsFromOthers` are
both on. A room target rings every device there that accepts; the first answer wins and the others stop. Left out:
drop-in, listen-in, auto-answer, video, groups, phones, call links, voice nodes, "call Sam" by person.

### 9.3 Risks and decisions

- **Q15. What may a call do on a device nobody is at?** Recommended: ring for 30 seconds with a card, then become a
  missed call. The microphone is never opened for a call without an answer on that device (a tap, or the answer phrase
  after the wake phrase). No auto-answer, no drop-in, no listen-in in this version.
- **Q16. Who may call whom?** Recommended: any device may call a device whose "accepts calls" is on; the owner switches
  it on per device. The caller's name is the name of the device it claims to be: device ids are not authenticated, so
  the card cannot prove who is calling. A call stays `change` (MODULES-PLAN §2 row 5).
- **Q17. May "answer" be said without the wake phrase?** Recommended: no. The ringing window cannot tell a television
  from a person (MODULES-STATUS open points), and a false "answer" opens a microphone to another room. "Decline" and
  "stop" stay wake-free: a false one only stops a ring.
- **Q18. Can a voice at the far end use the callee's assistant?** Recommended: no: during a call a wake-phrase
  utterance reaches only the host's controls and the call's phrases (C1), so the far end cannot ask for personal
  content or run a tool on the callee's device.
- Risk: echo. The far end's voice is played out of the callee's speaker; browsers cancel echo of their own Web Audio
  output only in some versions (calls-and-intercom.md §12). Measured on real devices before the module PR is opened.
- Risk: mouth-to-ear latency over the relay is a research estimate (80 to 200 ms on a LAN), not a measurement.

### 9.4 Review and tests

With the app's scripted clients (`apps/assistant/test/support/scriptedClient.ts`): binding (a second tab, a takeover,
a frame from the wrong connection), the limits, a disconnect mid-ring, do not disturb, a restart; the phrase decision's
guard as unit tests on recogniser events; Playwright on two pages for the ring, answer and overlay (run once by the
lead). Only real devices show echo and mouth-to-ear delay; the PR reports a click test with `CallTrace` numbers.

## 10. The test kit

What modules here need from `@pva/core/testing` and `@pva/net`, each added by the pull request that adds the thing it
imitates: streamed fixtures and a scripted WebSocket peer in `makeOfflineNet` (N2); a clock the helper's stream limits
take (N2); `makeTestAccounts` and an account `checkModule` rule (A1); a fake OAuth provider and a fake MCP
authorization server on the offline network (A2, A3); Effect's `McpTest` for MCP servers (M1); the scripted clients and
a call harness for the relay (C2). The kit still does not imitate the HTTP router (MODULES-PLAN §4 P11).

## 11. All pull requests

| # | Pull request | Branch | Based on | Depends on | Model |
|---|---|---|---|---|---|
| N1 | Request kinds: form bodies, DAV methods, `fetchFixedPublic` | `t3/modules-12-net-requests` | top of the stack | – | Sonnet |
| N2 | Streams, `netHttpClient`, WebSocket client | `t3/modules-13-net-streams` | N1 | N1 | Opus |
| A1 | Accounts with pasted credentials | `t3/modules-14-accounts` | N2 | none (stacked to keep one line) | Opus |
| A2 | OAuth with an owner-registered client | `t3/modules-15-oauth` | A1 | A1, N1 | Opus |
| A3 | OAuth for an MCP server | `t3/modules-16-oauth-mcp` | A2 | A2, N2 | Opus |
| M6 | Home Assistant on a WebSocket | `t3/module-smart-home-websocket` | N2 + `t3/module-smart-home` | N2 | Opus |
| M1 | mcp-client, read only, pasted tokens | `t3/module-mcp` | A1 | N2, A1 | Opus |
| M2 | Calendar: CalDAV read | `t3/module-calendar-caldav` | A1 + `t3/module-calendar` | N1, A1 | Sonnet |
| M3 | Calendar: add single events | `t3/module-calendar-add` | M2 | M2 | Sonnet |
| M4 | google: mail read only | `t3/module-google` | A2 | A2 | Opus |
| M5 | Calendar: Google provider | `t3/module-calendar-google` | M4 + M2 | M4, M2 | Sonnet |
| M7 | t3-code, read only | `t3/module-t3-code` | A3 | A3, N2 | Sonnet |
| M8 | mcp-client: OAuth servers | `t3/module-mcp-oauth` | M1 + A3 | M1, A3 | Sonnet |
| C1 | Call guard, device targets, wake-only actions | `t3/modules-17-call-guard` | A3 (top of the stack) | P7, P9 | Opus |
| C2 | Call relay | `t3/modules-18-call-relay` | C1 | C1 | Opus |
| C3 | calls, stage 1 | `t3/module-calls` | C2 | C2 | Opus |

N1 to A3 and C1 to C2 are the preparation stack, each on the one before it. The module PRs are written in parallel as
soon as what they depend on is written, under MODULES-PLAN §3.2 (a module PR touches its own package and its own
`docs/modules/<id>.md`; M2, M3 and M5 all touch the calendar package and so are stacked). Each is reviewed under
MODULES-PLAN §6.

## 12. Out of scope even then

From MODULES-PLAN §7, what changes:

- **Now in**: accounts and OAuth (A1 to A3), and with them the calendar's CalDAV and Google providers, google's mail
  reads, t3-code's reads, the MCP client and a two-device audio intercom.
- **Still out, unchanged**: deployment (with it, unlocking the vault unattended), voice nodes, phone channels, the kids
  policy, a filler line for slow tools, the Jev intent agent as an agent, the second round's core pieces, tiers 3 to 5.
- **Still out, and now named because something here stops at it**: authenticated devices, and with them every
  `money` and `security` action, t3-code's write half and trusting a caller's name; confirmation, and with it every
  `message` action: sending mail and drafts, starting, messaging or answering T3 threads, outward MCP tools, call
  links.
- **Out of this plan's first versions**: the device authorization grant, an OAuth callback route, Client ID Metadata
  Documents and authorization servers on another origin; Microsoft accounts; stdio MCP servers, MCP tasks,
  elicitation, sampling, MCP Apps and `find_tool`; the mail cache, Gmail push, contacts, Drive and Tasks; CalDAV
  discovery, calendars on another host, VTODO, changing and deleting events; video calls, WebRTC, an SFU, phone
  numbers, drop-in, listen-in, groups and calls with voice nodes.

## 13. Where MODULES-PLAN is wrong or stale in the light of the code

1. "Order from here" item 5: `@pva/net` already POSTs JSON once to an owner-typed address, with typed loopback; the gaps
   are other methods and bodies, streams and sockets (§3.1).
2. P8 and §5.1 rows 9, 14, 15: "connections" and `ctx.connections` collide with `CurrentTurn.connection` and the host
   view's per-device `connections` count (§4).
3. P3: module routes are said to serve OAuth callbacks, but the `admin` guard is a bearer header that a browser
   redirect cannot carry; a callback would be a `public` route. The first version needs none (Q3).
4. Appendix A: `@modelcontextprotocol/client` and `tsdav` make their own requests, which docs/MODULES.md §12 forbids;
   Effect 4.1.4's `effect/ai/McpClient` over `@pva/net` and hand-written CalDAV requests replace them (§5.1, §6.1).
5. §5.1 row 15 and §5.2: t3-code does not need the mcp-client module or an `Mcp` service (§8.1).
6. §5.1 rows 12 and 14, §5.2: `CalendarProvider` is internal to the calendar package; Google's calendar is a provider
   there, not a contribution of the google module (§6.1, §7.2).
7. §5.1 row 23: calls also need the phrase decision (the `call` guard P7 did not build) and a `{ device }` target in
   the notification service, which has only `origin` and `everywhere` (§9.1).
8. §5.1 row 22: "both protocol revisions": Effect's client supports both but picks one per transport; the fallback is
   the module's (§5.1).
