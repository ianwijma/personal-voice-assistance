// Exchange rates: Frankfurter's public API (no key), fetched once a day and kept in the household store. Fiat currencies
// only: the service also lists crypto, which is left out here (docs/modules/calculator.md).
import { contentTypes, safeFetch } from "@pva/net"
import { Effect, Schema } from "effect"
import { type NetDeps } from "./net.ts"

export const RATES_URL = "https://api.frankfurter.dev/v2/rates?base=EUR"
export const MAX_RATES = 400

const Answer = Schema.Array(
  Schema.Struct({ date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)), quote: Schema.String.check(Schema.isPattern(/^[A-Z]{3,10}$/)), rate: Schema.Number })
).check(Schema.isMaxLength(2_000))
const decodeAnswer = Schema.decodeUnknownResult(Answer)

export interface RateTable {
  /** The date of the newest rate (YYYY-MM-DD). */
  readonly date: string
  /** Units of each currency for one euro. */
  readonly perEuro: ReadonlyMap<string, number>
}

export type RatesFailure = "unreachable" | "rubbish"

const fiat = (): ReadonlySet<string> => new Set(Intl.supportedValuesOf("currency"))

/** Read the service's answer: a list of { date, quote, rate }, kept to ISO fiat codes, at most `MAX_RATES`, finite and positive. */
export const parseRates = (json: unknown): RateTable | undefined => {
  const decoded = decodeAnswer(json)
  if (decoded._tag !== "Success") return undefined
  const known = fiat()
  const perEuro = new Map<string, number>()
  let date = ""
  for (const row of decoded.success) {
    if (!known.has(row.quote) || !Number.isFinite(row.rate) || row.rate <= 0 || row.quote === "EUR") continue
    if (perEuro.size >= MAX_RATES) break
    perEuro.set(row.quote, row.rate)
    if (row.date > date) date = row.date
  }
  return perEuro.size === 0 ? undefined : { date, perEuro }
}

export const fetchRates = (deps: NetDeps, userAgent: string): Effect.Effect<RateTable, RatesFailure> =>
  safeFetch(RATES_URL, { accept: contentTypes.json, maxBytes: 256 * 1024, timeoutMs: 5_000, headers: { "user-agent": userAgent }, ...deps }).pipe(
    Effect.mapError((): RatesFailure => "unreachable"),
    Effect.flatMap((response) =>
      response.status < 200 || response.status > 299
        ? Effect.fail<RatesFailure>("unreachable")
        : Effect.try({ try: () => parseRates(JSON.parse(response.text())), catch: (): RatesFailure => "rubbish" }).pipe(
          Effect.flatMap((table) => (table === undefined ? Effect.fail<RatesFailure>("rubbish") : Effect.succeed(table)))
        )
    )
  )

/** The stored form: "USD 1.0813;GBP 0.8731". */
export const encodeTable = (perEuro: ReadonlyMap<string, number>): string => [...perEuro].map(([code, rate]) => `${code} ${rate}`).join(";")

export const decodeTable = (text: string): Map<string, number> => {
  const out = new Map<string, number>()
  for (const part of text.split(";")) {
    const [code, rate] = part.split(" ")
    const value = Number(rate)
    if (code !== undefined && /^[A-Z]{3}$/.test(code) && Number.isFinite(value) && value > 0 && out.size < MAX_RATES) out.set(code, value)
  }
  return out
}
