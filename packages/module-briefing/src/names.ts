import type { BriefingSection, Language } from "@pva/module-contracts"
import { wellFormed } from "./compose.ts"

/** A section id as the owner and a person may give it: the contract's alphabet, starting with a letter or digit. */
export const SECTION_ID = /^[a-z0-9][a-z0-9.-]{0,59}$/

/**
 * The names this module itself suggests for the sections its sources contribute (the module's id is the section's
 * id, as the contract says), in both languages: "skip the news" and "laat het nieuws weg" both mean `news`.
 */
export const SUGGESTED: ReadonlyArray<{ readonly id: string; readonly en: string; readonly nl: string; readonly also: ReadonlyArray<string> }> = [
  { id: "weather", en: "weather", nl: "weer", also: ["forecast", "weerbericht"] },
  { id: "calendar", en: "calendar", nl: "agenda", also: ["appointments", "afspraken", "kalender"] },
  { id: "news", en: "news", nl: "nieuws", also: ["headlines"] },
  { id: "bin-day", en: "bins", nl: "afval", also: ["bin day", "bin-day", "rubbish", "kliko", "containers"] },
  { id: "reminders", en: "reminders", nl: "herinneringen", also: [] }
]

/** Lower case, one space, no leading article ("the news", "het nieuws"), no closing full stop. */
const key = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "").replace(/^(the|de|het) /, "")

/**
 * The section id a spoken or written name means: a name this module suggests (either language), the id of a section
 * that is on, or its title. `undefined` when it means none of them: never guessed, never widened.
 */
export const resolveName = (name: string, live: ReadonlyArray<BriefingSection>): string | undefined => {
  const k = key(name)
  if (k === "") return undefined
  const suggested = SUGGESTED.find((s) => s.id === k || s.en === k || s.nl === k || s.also.includes(k))
  if (suggested !== undefined) return suggested.id
  const sections = live.filter(wellFormed)
  const byId = sections.find((s) => s.id === k)
  if (byId !== undefined) return byId.id
  return sections.find((s) => key(s.title) === k)?.id
}

/** How a section id is said: the suggested name in the household's language, else its section's title, else the id. */
export const nameOf = (id: string, live: ReadonlyArray<BriefingSection>, language: Language): string => {
  const suggested = SUGGESTED.find((s) => s.id === id)
  if (suggested !== undefined) return suggested[language]
  const title = live.filter(wellFormed).find((s) => s.id === id)?.title
  return title !== undefined ? title.trim().toLocaleLowerCase(language) : id
}

/** The names a person can use now: those of the sections that are on, else the suggested ones. At most 20. */
export const knownNames = (live: ReadonlyArray<BriefingSection>, language: Language): ReadonlyArray<string> => {
  const ids = [...new Set(live.filter(wellFormed).map((s) => s.id))]
  const names = ids.length > 0 ? ids.map((id) => nameOf(id, live, language)) : SUGGESTED.slice(0, 3).map((s) => s[language])
  return [...new Set(names)].slice(0, 20)
}

/**
 * A list of names as ids, all or nothing: `{ ids }` when every name means a section id (an id-shaped name of a section
 * that is off is kept only when it is one this module suggests), `{ unknown: true }` when any does not.
 */
export const resolveAll = (names: ReadonlyArray<string>, live: ReadonlyArray<BriefingSection>): { readonly ids: ReadonlyArray<string> } | { readonly unknown: true } => {
  const ids: Array<string> = []
  for (const n of names) {
    const id = resolveName(n, live)
    if (id === undefined) return { unknown: true }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ids }
}

/**
 * A setting's list of ids (the owner's order, the household's skips), read strictly: each entry a section id or a name
 * this module suggests. The first entry that is neither is reported (its place, never its text) so the module can
 * refuse the settings instead of ignoring it.
 */
export const settingIds = (entries: ReadonlyArray<string>): { readonly ids: ReadonlyArray<string> } | { readonly bad: number } => {
  const ids: Array<string> = []
  for (const [n, entry] of entries.entries()) {
    const k = key(entry)
    const id = SUGGESTED.find((s) => s.id === k || s.en === k || s.nl === k || s.also.includes(k))?.id ?? (SECTION_ID.test(k) ? k : undefined)
    if (id === undefined) return { bad: n + 1 }
    if (!ids.includes(id)) ids.push(id)
  }
  return { ids }
}
