import { Schema } from "effect"

/**
 * Settings set outside the UI (docs/SETTINGS-UI.md §4.4): every environment variable the assistant knows that is
 * set, with where it came from. A variable from a `.env` file can be moved into the saved settings (its value goes
 * to the settings, or to the key vault for a key) and its line is commented out of the file. Values are never sent.
 */

/**
 * - `setting`: something the UI configures (a field, or an engine setting without a field yet): it can be moved;
 * - `bootstrap`: read before the UI exists (`PVA_VAULT_PASSWORD`, `PVA_DATA_DIR`, `SERVE_HOST`, …): stays in `.env`;
 * - `development`: benchmarks, tests and the command-line modes;
 * - `unknown`: nothing reads it (often a typo, e.g. `STT_SHERPA_MODLE`).
 */
export const EnvKind = Schema.Literals(["setting", "bootstrap", "development", "unknown"])
export type EnvKind = typeof EnvKind.Type

export const EnvEntry = Schema.Struct({
  key: Schema.String,
  origin: Schema.Literals(["file", "process"]),
  /** The `.env` file and line (for `origin: "file"`). */
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int),
  kind: EnvKind,
  /** A key or token: moved into the key vault (refused while it is locked). */
  secret: Schema.Boolean,
  /** The settings page that shows it (`#settings/<category>/<page>` as a path), when there is one. */
  page: Schema.optionalKey(Schema.Struct({ path: Schema.Array(Schema.String), title: Schema.String })),
  /** "Move to settings" is possible: a setting from a `.env` file. */
  movable: Schema.Boolean,
  /**
   * Protocol 11: the assistant does not read this variable and says why (`HOUSEHOLD_MEMBERS`: people get ids the
   * server makes, which an environment variable cannot hold). Shown instead of a page link.
   */
  refused: Schema.optionalKey(Schema.String)
})
export type EnvEntry = typeof EnvEntry.Type

export const EnvInfo = Schema.Struct({
  /** The `.env` files read at start, in the order they were applied (the first one wins). */
  files: Schema.Array(Schema.String),
  entries: Schema.Array(EnvEntry)
})
export type EnvInfo = typeof EnvInfo.Type

/** At most this many keys per `settings.moveFromEnv`. */
export const MAX_MOVE_KEYS = 200
