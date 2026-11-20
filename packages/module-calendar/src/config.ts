import { type PeopleService, Setting } from "@pva/core"
import { isLine } from "@pva/module-contracts"
import { NAME_CHARS } from "./store.ts"

/**
 * The module's settings (docs/MODULES.md §9; docs/modules/calendar.md, "Settings"): the calendars as flat records, three
 * secret slots for ICS addresses that are themselves secrets, and how often they are read.
 */

const MAX_URL_CHARS = 2_000

/** An ICS address as typed: `https://…`, `http://…` or `webcal://…` (read as `https://`). Empty is allowed here. */
const urlProblem = (text: string): string | undefined => {
  const t = text.trim()
  if (t === "") return undefined
  const asHttp = t.replace(/^webcal:\/\//i, "https://")
  let url: URL
  try {
    url = new URL(asHttp)
  } catch {
    return "Must be an address that starts with https://, http:// or webcal://"
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Must be an address that starts with https://, http:// or webcal://"
  if (url.username !== "" || url.password !== "") return "An address with a user name or password in it is not read; use a private link instead"
  return undefined
}

export const LINK_SLOTS = ["private1", "private2", "private3"] as const
export type LinkSlot = (typeof LINK_SLOTS)[number]

const calendarItem = {
  name: Setting.text({
    label: "Name",
    description: "What the calendar is called when it is read out (\"Family\", \"School\", \"Sam's work\").",
    maxLength: NAME_CHARS,
    check: (v) => (v.trim() === "" ? "A calendar needs a name" : !isLine(v, NAME_CHARS) ? "One line, without line breaks" : undefined)
  }),
  link: Setting.choice({
    label: "Address from",
    description: "Typed below, or one of the private links (secrets) further down this page.",
    options: [
      { value: "address", label: "The address below" },
      { value: "private1", label: "Private link 1" },
      { value: "private2", label: "Private link 2" },
      { value: "private3", label: "Private link 3" }
    ],
    default: "address"
  }),
  url: Setting.text({ label: "ICS address", placeholder: "https://example.org/calendar.ics", maxLength: MAX_URL_CHARS, check: urlProblem }),
  owner: Setting.text({
    label: "Whose calendar",
    description: "Empty for the household's. Otherwise a member's name or id: their events are personal and read out only where the privacy rule allows.",
    maxLength: 60,
    check: (v) => (v === "" || isLine(v, 60) ? undefined : "One line, without line breaks")
  })
}

export type CalendarConfig = {
  readonly name: string
  readonly link: "address" | LinkSlot
  readonly url: string
  readonly owner: string
}

export const MAX_CALENDARS = 10

export const settings = {
  calendars: Setting.records({
    label: "Calendars",
    description: "ICS addresses (a school, a club, a shared or published calendar). They are read on a schedule; the assistant answers from what was read.",
    itemLabel: "calendar",
    titleKey: "name",
    maxItems: MAX_CALENDARS,
    orderable: true,
    item: calendarItem,
    check: (list) => {
      const seen = new Set<string>()
      for (const c of list) {
        const key = c.name.trim().toLowerCase()
        if (seen.has(key)) return `Two calendars are called "${c.name.trim()}"; give each its own name`
        seen.add(key)
        if (c.link === "address" && c.url.trim() === "") return `The calendar "${c.name.trim()}" needs an ICS address, or a private link chosen in "Address from"`
      }
      return undefined
    }
  }),
  privateLink1: Setting.secret({ label: "Private link 1", description: "An ICS address that is itself a secret (a private Google or iCloud link). Kept in the key vault; never shown or spoken." }),
  privateLink2: Setting.secret({ label: "Private link 2", description: "Another secret ICS address." }),
  privateLink3: Setting.secret({ label: "Private link 3", description: "Another secret ICS address." }),
  refresh: Setting.choice({
    label: "Read the calendars every",
    options: [
      { value: "15", label: "15 minutes" },
      { value: "30", label: "30 minutes" },
      { value: "60", label: "hour" },
      { value: "180", label: "3 hours" }
    ],
    default: "60"
  })
}

export interface CalendarSettings {
  readonly calendars?: ReadonlyArray<CalendarConfig>
  readonly privateLink1?: string | undefined
  readonly privateLink2?: string | undefined
  readonly privateLink3?: string | undefined
  readonly refresh?: "15" | "30" | "60" | "180"
}

/** The cron of the refresh job for the setting: a few minutes past, so the household's calendars are not read on the hour exactly. */
export const refreshCron = (refresh: CalendarSettings["refresh"]): string => {
  switch (refresh) {
    case "15":
      return "*/15 * * * *"
    case "30":
      return "*/30 * * * *"
    case "180":
      return "7 */3 * * *"
    default:
      return "7 * * * *"
  }
}

/** The address to read for a calendar (`webcal://` as `https://`), or `undefined` when its private link is not set. */
export const addressOf = (c: CalendarConfig, s: CalendarSettings): string | undefined => {
  const raw = c.link === "address" ? c.url : c.link === "private1" ? s.privateLink1 : c.link === "private2" ? s.privateLink2 : s.privateLink3
  if (raw === undefined || raw.trim() === "") return undefined
  return raw.trim().replace(/^webcal:\/\//i, "https://")
}

/**
 * Whose a calendar is now: `household`, a member (by id, or by a name `People.find` finds once), or `unknown` (a name
 * nobody in Members has, or two people answer to): an unknown owner's events are never imported.
 */
export type OwnerOf = { readonly kind: "household" } | { readonly kind: "person"; readonly id: string } | { readonly kind: "unknown" }

export const ownerOf = (c: Pick<CalendarConfig, "owner">, people: PeopleService | undefined): OwnerOf => {
  const text = c.owner.trim()
  if (text === "") return { kind: "household" }
  if (people === undefined) return { kind: "unknown" }
  const byId = people.get(text)
  if (byId !== undefined) return { kind: "person", id: byId.id }
  const found = people.find(text)
  return found.kind === "found" ? { kind: "person", id: found.person.id } : { kind: "unknown" }
}

export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * The shortest part of a private link that counts as a credential: its file name, that name's stem (without the
 * extension) and each query value from 8 characters; any other path component from 12 (so a plain word of a provider's
 * path, `calendar`, is not one).
 */
export const SECRET_PART_CHARS = 8
const PATH_PART_CHARS = 12

/**
 * What text read from a calendar must not contain, for a calendar read from a private link (a secret): the address
 * itself (with and without its scheme, as typed and decoded), its path and query, its file name and that name's stem
 * (`long-secret-123456789` of `…/long-secret-123456789.ics`), each query value, and each other path component long
 * enough to be a token. Lower case; compared with text that is lower-cased and decoded too. The one set is applied to
 * everything read from the feed (titles, places, UIDs) and to its validator (`ETag`; `Last-Modified` is not read). A
 * typed address is not a secret: nothing is forbidden for it.
 */
export const secretPartsOf = (c: Pick<CalendarConfig, "link">, address: string): ReadonlyArray<string> => {
  if (c.link === "address") return []
  const parts = new Set<string>()
  const add = (s: string, min = SECRET_PART_CHARS) => {
    for (const form of [s, decoded(s)]) {
      const t = form.trim().toLowerCase()
      if (t.length >= min) parts.add(t)
    }
  }
  add(address)
  add(address.replace(/^[a-z]+:\/\//i, ""))
  let url: URL | undefined
  try {
    url = new URL(address)
  } catch {
    url = undefined
  }
  if (url !== undefined) {
    add(`${url.host}${url.pathname}${url.search}`)
    add(`${url.pathname}${url.search}`)
    const path = url.pathname.split("/").filter((x) => x !== "")
    const file = path.at(-1)
    for (const piece of path.slice(0, -1)) add(piece, PATH_PART_CHARS)
    if (file !== undefined) {
      add(file)
      // The file name's stem: the credential without its extension.
      add(decoded(file).replace(/\.[A-Za-z0-9]{1,6}$/, ""))
    }
    for (const [key, value] of url.searchParams) {
      add(value)
      add(`${key}=${value}`)
    }
    if (url.hash.length > 1) add(url.hash.slice(1))
  }
  return [...parts]
}
