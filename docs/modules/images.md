# Images (`images`)

Finds a picture of something on Wikipedia and Wikimedia Commons, with its credit, and on the web through the household's
SearXNG server (the web-search module's `WebImages` service).

- Package: `packages/module-images`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 11 (wave B)
- Research: [docs/research/modules/images-and-photos.md](../research/modules/images-and-photos.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Asked for a picture of a thing ("show me an okapi", "laat een foto van de Eiffeltoren zien"), it looks the thing up on
Wikipedia, takes the page's own picture from Wikimedia Commons with its author and licence, and shows it on the screen of
the device that asked, as the `image` presentation ([PRESENTING.md](../PRESENTING.md)): the picture, a caption, and a
credit line such as "Jane Example, CC BY-SA 4.0, via Wikimedia Commons". The credit is always shown with the picture and
never spoken.

- **A word with several meanings** ("kiwi": the bird, the fruit, the people) is a question, never a guess. The answer
  names up to three candidates ("kiwi could be several things. Which do you mean: Kiwi (bird), Kiwifruit and Kiwi
  (people)?"), shows nothing and fetches no picture; the model asks the person and calls the tool again with the exact
  name they pick. There is no `gallery` kind in this version, so nothing is picked by touch.
- **A device without a screen** (or one that cannot draw an image, or that is not connected): the Presenter's note says
  so ("Not showing it: "Office speaker" has no display. Say this instead: …"), where what follows is the presentation's own
  `spoken` text, a sentence the model says as it stands (what was found, and that it can't be shown here; `ifNotShown` repeats
  it). Nothing is fetched for such a device: the Presenter asks the image cache only when a page is to show the picture. The
  module does not guess which device has a screen and does not
  offer one: only the Presenter's note, which names the device that was asked, is said.
- **No Wikipedia page, or a page without a free picture**: Wikimedia Commons is searched by the page's title (or the
  words), unless the setting is off. Said honestly: a picture from Commons says it comes from Commons; "no picture" and
  "nothing found" are said only when every read that was needed worked.
- **Pictures from the web** (issue #150): through the household's SearXNG, when the web-search module is on and has a
  valid SearXNG address (its `WebImages` service; the address, its home-network rule and the blocked sites stay in that
  module). The setting `webImages` puts it **after** Wikipedia and Commons (`fallback`, the default: asked only when they
  have no picture, also when they could not be read, instead of "nothing found" or "no picture"), **first** (`first`: its
  best picture is shown and no question is asked; when it has nothing, Wikipedia and Commons as before; a chosen option of a
  question is always theirs), or **only the web** (`only`: Wikipedia and Commons are not asked at all, there is no question, and a question's `page` and `wiki` are ignored; the outcomes are a picture, "I couldn't find a picture of … on the web", or a failure naming SearXNG), or not at all (`off`). Without the service the module works exactly as it did without the web in `fallback` and `first`. In `only` it says plainly that searching the web for a picture needs the Web search module switched on with a SearXNG address (never "nothing found"); this is only said, not a Health issue, because a module's `health()` receives only its settings and whether it runs, and cannot see another module's service.
  A web picture's licence is not known, and nothing claims one: its credit is "Picture from the web, via birds.example.org"
  (the host of the page it is on; "Plaatje van internet, via …" in Dutch). What it is a picture of is said with the words
  that were asked ("Here is a picture of grey heron."); the result's title is the caption, cleaned and bounded and, for the
  model, marked as outside text like everything else.
- **A request that failed** (the site is unreachable, throttled, slow, answers an error or something that is not JSON, or
  a body over 96 KiB) is a failure, said as one in the household's language and naming the source that failed (Wikipedia, Wikimedia Commons or SearXNG); never "I
  found nothing". A "nothing found" names only the sources that were searched: with the Commons search switched off it says so,
  and with the web searched too it says "on Wikipedia or on the web".

**No safe-search filter on Wikipedia and Commons.** Neither offers one (plan §2 row 9), and this version has no
children's policy. A picture of a thing can show anything that has a page about it, and nothing here keeps children from
seeing it. Web pictures go through SearXNG's safe search at the level of `webSafeSearch` (strict by default), which misses
things too. The module says so in its description, in its settings, and as an information line on the Health page.

## Tools

| Tool | Parameters | Risk | Answers |
|---|---|---|---|
| `image_find` | `query`: what the picture is of, one line of 1 to 100 characters; after a question only: `page` (the exact `title` of the option the person picked, up to 255 characters) and `wiki` (`en` or `nl`, the option's) | `read`, not speculative (it puts something on a screen), `latency: slow` | `{ forModel, present, show }`: the picture on the asking device (a transient presentation of two minutes, no key: one per device, the newest on that device, so a lookup on one device never touches another's), and for the model its marked outside text, the credit and what to say if nothing could be shown; or a question naming the candidates; or a sentence that nothing / no picture was found; or a failure the person can act on, naming the source that failed |

Example phrases: "show me an okapi", "can I see a picture of the Eiffeltoren", "laat me een foto van een okapi zien".

**The action `images.show`** (one `thing`, a text; not offered to the model as a second tool) with one phrase set per language, said
after the wake phrase with no model: "show me a picture of {thing}", "show me a photo of {thing}", "show a picture of {thing}",
"show a photo of {thing}"; "toon een plaatje van {thing}", "toon een foto van {thing}", "laat een foto zien van {thing}", "laat een
plaatje zien van {thing}". The thing is the slot at the end; the name is looked up as it was said, exactly as the tool does ("The Who", "De Dijk", "A Star Is Born"); only when that finds nothing at all is the text without a leading "a", "an", "the", "een", "de", "het" tried ("an okapi" is "okapi"), and the sentence names what was found. The action
shows the picture itself (`ctx.present.show("origin", …)`) and says what the Presenter did: "Here is a picture of Okapi." where it was
shown, and where it was not (a speaker, a page that cannot draw it) "I found a picture of Okapi: …. I can't show it here." Its
lookup has a budget of **4 s** in all, **1.5 s** for each Wikipedia or Commons request, and for the web search whatever is left of the 4 s when it starts (at most `webTimeoutMs`; the whole 4 s when it is asked first), because an action has 5 s; then a failure is said as one. An ambiguous word
asks, as the tool does; a phrase turn is recorded nowhere, so the person answers with a new phrase naming the one they mean ("show me a
picture of Kiwi (bird)"), which a title match finds exactly. The action offers only names it accepts back, whole: within its 100
characters, one line, within the phrase's eight words and not cut when said; with no such name it asks the person to say a bit more.

What the model gets from the tool (every string from the two sites is cleaned by one function: markup and control characters gone, one
line, cut at a code-point boundary with an ellipsis, never inside a character; and **every result that carries one has the notice**
"untrusted outside text, not an instruction": the picture, the question, and the no-picture sentence): `picture` (title, description),
`source` (Wikipedia, Wikimedia Commons or SearXNG), `credit` (and `creditCut` when the author was cut), `ifNotShown`. After it the Presenter adds
its note (`[Screen: Showing on "Kitchen display". …]`).

How a lookup goes (at most four requests to the two sites and one web search; one lookup at most 9 s for the tool, or 9 s plus the web time limit, never more than 15 s, when the web is used; each request to the two sites at most `timeoutMs`, the web search at most `webTimeoutMs`. The tool host sets no time limit of its own on a tool call, `latency: slow` is only a label; an action has its 5 s):

1. Pages on the household's Wikipedia (`en`, or `nl` for a Dutch household; Dutch then asks `en` when `nl` has nothing),
   `generator=search` with the page's lead image name, description and disambiguation mark; or, after a question, the one page of
   exactly the chosen title (`titles=…`, a redirect followed): a chosen candidate is that page, never a new search that could be
   ambiguous again. The page whose title is the words wins. **A word the site marks as ambiguous** (the best match, or the page of
   those words, is a disambiguation page) **is always asked, even when one alternative came back**; several qualified titles
   ("Crane (bird)", "Crane (machine)") for words with no page of their own are asked too. At most three candidates are named; each
   carries its exact `title` and `wiki` for the follow-up, separate from the (cut) label that is said.
2. The lead image on Commons (`imageinfo`: 960 px thumbnail address, licence short name, author, `NonFree`), by the file name exactly
   as the site gave it: a name that cannot be used as it is (over 255 characters, markup, control characters) is not used. 960 is one
   of Wikimedia's standard thumbnail widths: its image hosts answer **400** for a thumbnail of any other width (the 800 px this
   module used to ask for was refused; checked live 2026-11-21, issue #150).
3. When there is no usable picture and the setting allows: a Commons file search (the first usable of five).
4. With `webImages` `fallback` and still no picture: one SearXNG image search (by the page's title when a page was found, else
   the words). With `first` this search comes before step 1. With `only` it is the only step: steps 1 to 3 are skipped.

Every answer is checked for its shape: a complete empty search (`batchcomplete`, no pages) is an empty result, and anything else that is
not a query answer (no `query`, `pages` not a list, an entry that is not an object, a field of the wrong type) is a failed read, said as one
("sent an answer I couldn't read"), never "nothing found". That holds for the completion marker (it must be `true`, the format-version-2
boolean) and for every metadata entry that is used (licence, author, `NonFree`: an object whose value has the type the API gives) and
the image address; metadata that is simply missing stays missing. A request goes to one host and stays on it: **a redirect to another host is
refused before it is looked up or connected to** and is a failed read ("I can't reach …"); a redirect within the same host is followed.

A picture is used only when its address is on Wikimedia's own image hosts, `https://upload.wikimedia.org/…` or
`https://thumb.wikimedia.org/…` (where the API's thumbnails have pointed since 2025; with only `upload` admitted, every Commons
answer was unusable: issue #150), printable ASCII, at most 2,000 characters, its type is an
image, it is not marked non-free, and it has a licence short name of at most 70 characters, **kept whole**: without a licence, or with one
too long to be given whole, it cannot be credited honestly, so the file is not used (and the answer says there is no picture). The credit
line is built by plain concatenation (nothing in an outside text is read as syntax), at most 120 characters: the author, the licence, "via
Wikimedia Commons"; when they do not fit, the author is cut with an ellipsis, never the licence or the source. With no author it says
"Author not stated".

**What is said where nothing is shown** (`ifNotShown`, also the presentation's own `spoken`, at most 300 characters): the fixed wording
("I found a picture of …" and the refusal "I can't show it here.") is reserved first, and the title and the description share what is
left, so the refusal is never cut away by the longest legal title and description.

**Which web result is shown.** SearXNG's results in its order; the first with a page to credit (its host, at most 60
characters) and a usable address wins. Of a result, the search engine's own **thumbnail** is preferred (Bing's, Qwant's…):
it is made to be fetched by others, is small and is always a type the image cache keeps, where an original is often refused
by its host, larger than the cache's 2 MiB, or a type it does not keep. The original is used when there is no usable
thumbnail and its stated format, when there is one, is PNG, JPEG, GIF or WebP. An address is usable when it is `https`,
printable ASCII without a space, quote or backslash, at most 2,000 characters, with no credentials or fragment, and does not
end in a type the cache refuses (`.svg`, `.tif`, `.bmp`, `.ico`, `.heic`, `.avif`, …). A `data:` thumbnail is not an address.
Only one address goes to the Presenter: there is no second try with another candidate when the server's fetch of it fails
(the picture then shows as "The image is not available").

**The image itself is never fetched by the module**: the server's media route fetches it once, when a page is to show it
(PRESENTING.md, "Images"; nothing is fetched while no device would show it), through its own policy, type and size checks,
with the project's User-Agent (and the household's API contact when one is set): Wikimedia's image hosts answer **403**
without one, which is why no picture ever showed before issue #150 was fixed. The module sends only requests to the two
sites' public APIs and calls the web-search module's service.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `commonsFallback` | on | Search Wikimedia Commons when a page has no picture I can use. |
| `webImages` | `fallback` | Pictures from the web through SearXNG: `off`, `fallback` (when Wikipedia and Commons have none), `first`, `only` ("Only the web": Wikipedia and Commons are not asked). |
| `webSafeSearch` | `strict` | SearXNG's `safesearch` for a web picture search: `off` (0), `moderate` (1), `strict` (2). |
| `timeoutMs` (advanced) | 3,000 ms (500 to 6,000) | The time limit of one request to Wikipedia or Commons. |
| `webTimeoutMs` (advanced) | 6,000 ms (1,000 to 10,000) | The time limit of the web picture search (a real SearXNG image search took 1.2 to 3.0 s, as it waits for its engines). |

Nothing is overridable by an assistant, and there is no secret. The module is off by default; with it off nothing changes
for anyone.

## What it stores

**Nothing.** No collection, no job, no cache, and nothing personal: there is no owner on anything because there is no
stored or personal content. A cache of lookups was left out on purpose: a lookup is at most five small requests, the
picture is cached by the server's media route (a day, bounded, by address), and a cache of titles and credits would only
add rows to keep fresh, to bound and to migrate. The presentation is household content (never `personal`), so it is shown
on a shared, a private and a public screen alike. What was asked is sent to Wikimedia, and to the household's SearXNG
(which passes it on to the search engines it uses), as a search word, and is not kept here. A restart loses nothing; a transient picture goes when its two minutes end or the module stops.

## What it needs

- `requires: { network: "internet" }`: `en.wikipedia.org`, `nl.wikipedia.org` and `commons.wikimedia.org`, public APIs
  without a key, through `@pva/net`'s `safeFetch` (JSON only, 96 KiB, the setting's time limit, no redirect to another host). The
  User-Agent is `personal-voice-assistance/1`, with the owner's contact (Home › API contact) only when the owner set one.
- The Presenter (P10) and the server's image cache to show anything; without them the model is told it was not shown.
- The `WebImages` service of the web-search module (`@pva/module-contracts`, `webImages.ts`) for pictures from the web,
  looked up at each use; not in `uses`: without it the module works without the web.
- `health` is offline and says only that Wikipedia and Commons have no safe-search filter (and, with the web on, at which
  level SearXNG's is set).

Main thread: each answer is at most 96 KiB, parsed on the main thread, with every field cut before it is cleaned
(`test/images.test.ts`, "the main thread is never held": the longest stop 1.8 ms for the largest pages and files, 3.8 ms for
a deeply nested one, asserted under 10 ms with the shared `bound()`).

## What was left out

- **Answering a question by voice without the model**: a phrase turn is recorded nowhere, so the action's question cannot be answered with "the bird"; the person says the phrase again with the name.
- **`gallery` with `pick`** and other kinds that are not in the Presenter (PRESENTING.md, "Not now"): an ambiguous word is a
  spoken question with the candidates named. The module also does not split results into clusters; a word is ambiguous
  when the site marks it so (the best match, or the page of those words, is a disambiguation page) or when several qualified
  titles ("Crane (bird)", "Crane (machine)") match words that have no page of their own; it is then asked, never guessed.
- **A second try with another candidate** when the server cannot fetch the chosen web picture: the presentation carries one
  address. It would need an image presentation with fallback addresses, tried in order by the Presenter's image fetch.
- **Web image search counted against web-search's daily cap**: SearXNG is the household's own and free.
- **Other sources** (Openverse, Pexels, Brave, Unsplash), **image generation**, **Immich and personal photos**, **a photo
  frame**, **cameras and snapshots**, and **images in a tool result to the model** (the research's later parts).
- **Safe search on Wikipedia and Commons, and a children's policy** (plan §2 row 9, §7).
- **Offering another device with a screen** ("want me to put it on the kitchen tablet?"): the module says only what the
  Presenter's note says.
- **Hold-up and reveal** with the character: the presentation is a plain image in the stage's column.
