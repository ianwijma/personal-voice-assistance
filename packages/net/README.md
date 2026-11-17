# @pva/net

Outgoing HTTP for URLs a model or a user chose, and for public APIs. No dependencies beyond Effect and `node:`.

- `safeFetch(url, options)` → `Effect<SafeResponse, SafeFetchError>`. Resolves the host itself, refuses non-public
  addresses (loopback, private, link-local incl. cloud metadata, CGNAT, unique-local, multicast, reserved, IPv4-mapped /
  NAT64 / 6to4 forms of those), connects to the address it checked (no second lookup), re-checks every redirect
  (default 3), allows `http`/`https` only, no credentials in the URL, ports 80/443, local names refused, size limit
  (default 2 MiB), total time limit (default 6 s), honours `signal` and Effect interruption. `allowLan: true` also
  allows private, unique-local and CGNAT addresses, local names and other ports; loopback, link-local and multicast stay
  refused. Errors: `NetRefused` (`rule`: `scheme | credentials | port | host-name | address | redirect-limit |
  redirect-target`, plus `address` and `addressClass`), `NetTooLarge`, `NetTimeout`, `NetAborted`, `NetFailure`
  (`stage`: `dns | connect | response`). The resolver and the connector are options, so tests need no network.
- `makeCachedJson({ cache?, now?, fetch?, headers? }).getJson(url, { ttlMs, staleIfErrorMs? })`: JSON GET with TTL,
  `ETag` / `If-None-Match`, stale-if-error and an injectable clock; in-memory `makeMemoryJsonCache` (implement `JsonCache`
  to back it with the store).
- `userAgent(contact)`: `personal-voice-assistance/1 (contact)`, or the token alone without a contact. `contact` is
  the Home section's `HOME_API_CONTACT`.
- `classifyAddress(text)`: the address class of an IPv4 or IPv6 address, for other guards.
