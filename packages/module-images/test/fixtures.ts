// The two sites' answers, as fixtures for the offline network: a table of pages by search words and of files by name.
import { makeOfflineNet, type OfflineConnector } from "@pva/core/testing"

export interface PageFixture {
  readonly title: string
  readonly description?: string
  readonly pageimage?: string
  readonly disambiguation?: boolean
  readonly index?: number
}
export interface FileFixture {
  readonly title: string
  readonly thumburl?: string
  readonly mime?: string
  readonly licence?: string
  readonly artist?: string
  readonly nonFree?: boolean
}

export const pageAnswer = (pages: ReadonlyArray<PageFixture>) => ({
  batchcomplete: true,
  query: {
    pages: pages.map((p, i) => ({
      pageid: 100 + i,
      ns: 0,
      title: p.title,
      index: p.index ?? i + 1,
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.pageimage !== undefined ? { pageimage: p.pageimage } : {}),
      ...(p.disambiguation === true ? { pageprops: { disambiguation: "" } } : {})
    }))
  }
})

export const fileAnswer = (files: ReadonlyArray<FileFixture>) => ({
  batchcomplete: true,
  query: {
    pages: files.map((f, i) => ({
      pageid: 900 + i,
      ns: 6,
      title: f.title,
      index: i + 1,
      imageinfo: [{
        thumburl: f.thumburl ?? `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(f.title.replace(/^File:/, ""))}/800px-${encodeURIComponent(f.title.replace(/^File:/, ""))}`,
        url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${encodeURIComponent(f.title.replace(/^File:/, ""))}`,
        mime: f.mime ?? "image/jpeg",
        extmetadata: {
          ...(f.licence !== undefined || f.licence === undefined ? { LicenseShortName: { value: f.licence ?? "CC BY-SA 4.0" } } : {}),
          ...(f.artist !== undefined ? { Artist: { value: f.artist } } : {}),
          ...(f.nonFree === true ? { NonFree: { value: "true" } } : {})
        }
      }]
    }))
  }
})

export interface World {
  /** Pages by the search words, per Wikipedia. */
  readonly en?: Readonly<Record<string, ReadonlyArray<PageFixture>>>
  readonly nl?: Readonly<Record<string, ReadonlyArray<PageFixture>>>
  /** Files by exact title (`File:…` without the prefix). */
  readonly files?: Readonly<Record<string, FileFixture>>
  /** Commons file search by words. */
  readonly search?: Readonly<Record<string, ReadonlyArray<FileFixture>>>
}

const empty = { batchcomplete: true }

export const worldNet = (world: World, wrap?: (c: OfflineConnector) => OfflineConnector) => {
  const wikiFixture = (table: World["en"]) => (request: { readonly url: URL }) => {
    const q = request.url.searchParams.get("gsrsearch") ?? ""
    const hit = table?.[q.toLowerCase()]
    return { body: hit === undefined ? empty : pageAnswer(hit) }
  }
  const net = makeOfflineNet({
    "https://en.wikipedia.org/w/api.php": wikiFixture(world.en),
    "https://nl.wikipedia.org/w/api.php": wikiFixture(world.nl),
    "https://commons.wikimedia.org/w/api.php": (request) => {
      const titles = request.url.searchParams.get("titles")
      if (titles !== null) {
        const file = world.files?.[titles.replace(/^File:/, "")]
        return { body: file === undefined ? { batchcomplete: true, query: { pages: [{ title: titles, missing: true }] } } : fileAnswer([file]) }
      }
      const q = request.url.searchParams.get("gsrsearch") ?? ""
      return { body: world.search?.[q] === undefined ? empty : fileAnswer(world.search[q]!) }
    },
    // The module never asks for the image: if it did, this would answer, and a test would see the request.
    "https://upload.wikimedia.org/": { status: 200, headers: { "content-type": "image/jpeg" }, body: new Uint8Array([1, 2, 3]) }
  })
  return { net, deps: { resolver: net.resolver, connector: wrap === undefined ? net.connector : wrap(net.connector) } }
}

export const KIWI_BIRD: PageFixture = { title: "Kiwi (bird)", description: "Flightless birds native to New Zealand", pageimage: "Apteryx_mantelli.jpg" }
export const KIWIFRUIT: PageFixture = { title: "Kiwifruit", description: "Edible berry of several species of woody vines", pageimage: "Kiwi_aka.jpg" }
export const KIWI_PEOPLE: PageFixture = { title: "Kiwi (people)", description: "Informal name for New Zealanders" }
export const KIWI_DISAMBIGUATION: PageFixture = { title: "Kiwi", description: "Topics referred to by the same term", disambiguation: true }
export const OKAPI: PageFixture = { title: "Okapi", description: "Giraffid native to the Congo", pageimage: "Okapi2.jpg" }

export const standardWorld: World = {
  en: {
    okapi: [OKAPI],
    kiwi: [KIWI_DISAMBIGUATION, KIWI_BIRD, KIWIFRUIT, KIWI_PEOPLE],
    "kiwi (bird)": [KIWI_BIRD, KIWIFRUIT],
    kiwifruit: [KIWIFRUIT]
  },
  nl: {
    okapi: [{ title: "Okapi", description: "Hoefdier uit Congo", pageimage: "Okapi2.jpg" }]
  },
  files: {
    "Okapi2.jpg": { title: "File:Okapi2.jpg", artist: "<a href=\"//commons.wikimedia.org/wiki/User:Example\">Jane Example</a>", licence: "CC BY-SA 4.0" },
    "Apteryx_mantelli.jpg": { title: "File:Apteryx_mantelli.jpg", artist: "Denis Bin", licence: "Public domain" },
    "Kiwi_aka.jpg": { title: "File:Kiwi_aka.jpg", licence: "CC BY 3.0" }
  }
}
