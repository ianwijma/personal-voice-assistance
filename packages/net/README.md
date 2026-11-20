# @pva/net

Outgoing HTTP for URLs a model or a user chose, and for public APIs. No dependencies beyond Effect and `node:`.

- `safeFetch(url, options)` → `Effect<SafeResponse, SafeFetchError>`. `options.accept` is **required**: the response types the caller
  takes, one of the presets `contentTypes.webPage` (`text/html`, `text/plain`, `application/pdf`: exactly what web-search §13 allows
  `read_page`),
  `contentTypes.json` (`application/json` and any `+json`), `contentTypes.feed` (RSS, Atom, RDF, JSON Feed, XML) and
  `contentTypes.image` (PNG, JPEG, GIF, WebP, AVIF; no SVG), or a policy of its own. A response without a Content-Type or with one the
  policy does not list is refused before its body is read (an error page outside 200–299 is returned with its status and an empty body
  instead). The `Content-Type` is read by one parser, `parseContentType(lines)`, from the raw field lines (never joined) by RFC 9110: more than one line is refused whatever they contain; one line must be `type/subtype` followed by `; name=value` parameters (a token or a quoted string, quoted-pairs unescaped; a trailing `;` is tolerated), and anything else (an unterminated quote, a comma or other text after the type or a parameter, a control character, an empty type or value, a parameter without `=`) is refused. Parameter names are case-insensitive, the first of a name wins, the type is lower-cased. A refusal is `content-type`, before the body is read; the same parse gives `contentType` and the `charset` for `text()`. The guard: resolves the host itself, refuses every address the IANA special-purpose registries do not mark globally
  reachable (loopback, private, link-local incl. cloud metadata, CGNAT, unique-local, multicast, documentation incl. `3fff::/20`,
  benchmarking, reserved, the IETF protocol blocks, and IPv4-mapped / NAT64 / 6to4 forms of those; `Address.ts` cites the registries),
  connects to the address it checked (no second lookup), re-checks every redirect (default 3), allows `http`/`https` only, no
  credentials in the URL, ports 80/443, local names refused, size limit `maxBytes` (default 2 MiB), which caps both the encoded bytes read and the decoded body, total time limit
  (default 6 s), honours `signal` and Effect interruption (an already-aborted signal starts no lookup and no connection, and a lookup
  or connection that fails after an abort never becomes an unhandled rejection). Requests ask for `identity`; a body that comes
  compressed anyway (gzip, deflate and br) is decompressed as it arrives by Node's streaming decompressors and its decompressed
  size counts; an empty body is empty; any other encoding is refused. `deflate` is the zlib format (RFC 9110 §8.4.1.2): a deflate
  body that is not a zlib stream (raw deflate included) is refused with the `content-encoding` rule, whatever the chunk boundaries.
  Deflate and br are single streams: bytes after the end of the stream (junk, or a second stream) are refused with `content-encoding`;
  gzip may be several members one after the other; after the last member, bytes from a zero byte on are ignored (as Node's gunzip
  and `gzip` itself treat padding: "hello" followed by a zero byte and "AB" is "hello"), and anything else that is not another member
  is a `NetFailure`. The decoded-size and time limits apply to what is read either way. A failure of
  the decompressor ends the read at once: a decompressed size over the limit is `NetTooLarge` and an invalid deflate stream is
  `NetRefused(content-encoding)` as soon as the offending bytes arrive (a zlib header is judged from its first two bytes, so a body that stalls after one byte ends at the deadline with `NetTimeout`), the connection is closed, and a body that never ends does not
  hold the request until the deadline. Request headers are
  checked: `Host`, hop-by-hop and framing headers and `Accept-Encoding` are refused, as are characters a header cannot hold; the Host
  header and the TLS name come from the URL only; a redirect to another origin keeps only `Accept`, `Accept-Language` and
  `User-Agent`, and any redirect drops the conditional headers (`If-None-Match`, …: a validator is about the URL it was sent to).
  A name with several addresses: they are tried in order, each attempt with an equal share of the time left (the last one all of
  it), so a black-holed first address does not use up the deadline; an attempt that runs out of its share is cancelled. `SafeResponse` has `contentType`, `encoding` and a `text()` that decodes by the `charset` parameter (UTF-8 when it has none or one this machine does not know). HEAD reads no body and is not
  limited by one.
- There is no LAN option on `safeFetch`, and it is GET and HEAD only, in its type and at run time (a cast `POST`, `body`,
  `typedLoopback` or `maxRequestBytes` is `NetRefused(options)`). `fetchOwnerConfiguredLan` is the separate function for endpoints
  the owner configured (Home Assistant, a LAN SearXNG): it also allows private, unique-local and CGNAT addresses, local names and
  other ports; loopback, link-local and multicast stay refused. Never pass it a URL a model chose.
  - `method: "POST", body: { json }`: the helper serialises `json` inside its error boundary (a value `JSON.stringify` cannot write,
    or a body that is not `{ json }`, is `NetRefused(body)`), refuses a body over `maxRequestBytes` (default 64 KiB, at most 128 KiB:
    the longest main-thread stop measured for the largest legal body (128 KiB of ~12 000 small properties, the worst shape found) is under 5 ms: a 1 ms heartbeat's longest gap 4.5–5.0 ms over 3 × 20 calls, median 1.4–1.8 ms; at 256 KiB it was 5.6–6.3 ms) before any lookup or connection; nothing is read from what the serialiser throws (the
    refusal's reason is constant); the one `timeoutMs` starts before serialising and is checked after it, and an aborted signal is
    checked before it, and sets `Content-Type: application/json` and `Content-Length` itself (a caller's is
    `NetRefused(header)`; the Node connector takes the length from the body whatever the headers say). A POST is sent once, to one
    server: every 3xx answer (300–399, 304 included) is `NetRefused(post-redirect)`; it is never retried; it goes on to the
    host's next address only when the connector rejected with `notSent: true` (`requestNotSent`): the Node connector says so for a
    failure before its socket connected (refused, unreachable, cancelled while connecting). A POST's share of the time per address
    ends when the connector calls `onConnect`; after that only the total limit applies. A failed POST may or may not have been
    carried out. Everything else (addresses on every hop, headers, response types, `maxBytes`, `timeoutMs`, interruption) is as
    for a GET.
  - `typedLoopback: true`: loopback only when the URL is given as text and its host, as written before the URL parser normalises it,
    is exactly a plain dotted quad `127.a.b.c` (decimal, no leading zeros), `[::1]` or `localhost` (ASCII, any case; connected as
    `127.0.0.1`, then `::1`, without a lookup). Refused with the option or without it: integer, hex and octal addresses (`2130706433`,
    `0x7f000001`, `0177.0.0.1`), short forms (`127.1`), a trailing dot (`127.0.0.1.`, `localhost.`), percent-escapes
    (`%6cocalhost`), other Unicode letters (`ℓocalhost`), `x.localhost`, mapped or embedded IPv4 (`[::ffff:127.0.0.1]`,
    `[::0.0.0.1]`), other spellings of `::1`, a `URL` object, a name that resolves to loopback, and a redirect to loopback.
- Errors never show a received header's value (a refused Content-Type or Content-Encoding is named, not quoted; a refused redirect
  names the URL that answered and the rule, not the target), nor a user name or password: a URL that does not parse is shown as
  `(not a valid URL)` (`invalidUrlShown`).
- Errors: `NetRefused` (`rule`: `scheme | credentials | port | host-name | address | redirect-limit | redirect-target | header |
  content-type | content-encoding | options | body | post-redirect`, plus `address` and `addressClass`), `NetTooLarge`, `NetTimeout`, `NetAborted`,
  `NetFailure` (`stage`: `dns | connect | response`). The resolver and the connector are options, so tests need no network.
- `makeCachedJson({ cache?, now?, fetch?, headers? }).getJson(url, { ttlMs, staleIfErrorMs?, headers?, fetch? })`: JSON GET (always
  the JSON preset) with TTL, `ETag` / `If-None-Match`, stale-if-error and an injectable clock. An entry remembers the URL its body
  came from: `If-None-Match` is sent only when the request goes to that resource (both URLs compared as serialised by the URL parser,
  without the fragment, so `http://a.example`, `HTTP://A.example:80/` and `http://a.example/x/../` are one resource), and a 304 renews the entry only when it comes from that
  resource without a redirect; any other 304 makes it ask again without conditions (a second 304 is `NetHttpStatus`). The client's
  `headers` and the call's are each checked and lower-cased, then merged name by name, the call's winning. `ttlMs` and
  `staleIfErrorMs` that are not numbers count as 0. An already-aborted `signal` fails with `NetAborted` also on a fresh hit. The cache key is the URL plus the request
  headers (`representationKey`, hashed), so one caller's `Authorization` never serves another. Callers that miss at the same time share
  one request; each keeps its own signal (it fails with `NetAborted`, never with a stale value) and its own interruption, and the request
  is cancelled when no one waits any more. The stale fallback measures the value's age after the failed request. Refreshes are
  ordered by the cache's monotonic `sequence()`, taken when a request starts, not by the clock: a slower request that started earlier
  never replaces what a later one stored (`setIfNewer`), also between clients that share a cache and in the same millisecond.
  In-memory `makeMemoryJsonCache(maxEntries)` (1 to 1 000 000, else `RangeError`); it keeps the order across eviction: an evicted
  key's sequence stays as a fence (at most `maxEntries`, then a floor), so a slow refresh that started before the eviction cannot
  store an older value after it (it is only not cached). Implement `JsonCache` (`get`, `setIfNewer`, `delete`, `sequence`) to back it
  with the store — a store shared by processes makes `setIfNewer` one transaction and `sequence` monotonic across them, and one that
  evicts keeps such a fence.
- `userAgent(contact)`: `personal-voice-assistance/1 (contact)`, or the token alone without a contact. `contact` is the Home section's
  `HOME_API_CONTACT` (which refuses characters a header cannot hold when saved); whatever it is given, the result is a legal header
  value (anything outside ASCII is percent-encoded).
- `classifyAddress(text)`: the address class of an IPv4 or IPv6 address, for other guards.
- `nodeConnector` is `makeNodeConnector()`; `makeNodeConnector({ ca })` trusts the given certificates instead of the system's (an
  owner's LAN CA, tests). Either way it dials the checked address, and SNI, the Host header and the certificate's name check come from
  the URL's host (an IP-literal URL is checked against that IP).

Tests: no test reaches the network. `test/NodeConnector.loopback.test.ts` and `test/NodeConnector.tls.loopback.test.ts` bind a
server on this machine's loopback interface to check what only a real socket shows (the Host header, a compressing server, an abort
mid-connection; a TLS handshake with a self-signed certificate made in the test: the connection goes to the checked address while
SNI and the certificate name are checked against the URL's host, and a wrong name, an untrusted certificate and an IP-literal URL
are refused); a socket on 127.0.0.1 is not network in this sense.
