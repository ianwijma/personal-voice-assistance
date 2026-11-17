"use client"
import { type FormEvent, useState } from "react"
import { type Assignment, type AssistantInfo, type DeviceSettings, TYPESAFE_GIVE_UP_MS, WAKE_PHRASES_MAX, type WithoutPhrase } from "@pva/protocol"
import { hearingModelNames, quoted } from "@/lib/assistants.ts"
import {
  answersWithoutPhrase,
  type DeviceBase,
  type DeviceEdit,
  followUpLabel,
  hearerId,
  isOwn,
  phraseConflict,
  recogniserWords,
  resetSection,
  sameRecogniser,
  sectionChanged,
  setKeys
} from "@/lib/devices.ts"
import { phraseProblem } from "@/lib/profileForm.ts"
import { formatSettingsHash } from "@/lib/settingsTree.ts"
import { useClientState } from "../../../context.tsx"
import { inputClass } from "../../../fields/types.ts"
import { Icon } from "../../../ui/Icon.tsx"
import { Button, cx } from "../../../ui/controls.tsx"
import { NumberControl, PresetControl } from "../assistants/parts.tsx"
import { Callout, Chip, DField, Pill, SectionMarks, useValueDraft } from "./parts.tsx"

const SELECT_STYLE = { backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M5 7.5l5 5 5-5'/%3E%3C/svg%3E\")" } as const
export const selectClass = "appearance-none bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9"

const FOLLOW_UP = [[0, "Off: one answer per phrase"], [5, "5 seconds"], [8, "8 seconds"], [15, "15 seconds"], [30, "30 seconds"]] as const

export interface SectionContext {
  readonly base: DeviceBase
  readonly edit: DeviceEdit
  readonly update: (f: (e: DeviceEdit) => DeviceEdit) => void
  /** The settings with the edits. */
  readonly settings: DeviceSettings
  readonly isType: boolean
  /** "this browser" / "these browsers". */
  readonly thisWord: string
  /** What a section follows: "Every browser". */
  readonly defaultsName: string
  readonly deviceName: string
  readonly setBlocked: (id: string, blocked: boolean) => void
  /** Changes when the draft is discarded or a section reset: the key of the number fields, so they start again. */
  readonly generation: number
  /**
   * Changes when the draft is discarded (Cancel, Load latest, a stale save), a section reset or a save sent: an edit
   * still on its way (a character whose chunk is loading) is dropped, even when the value it would land on is unchanged.
   */
  readonly epoch: number
  /** A reset of part of the draft: the number fields drop what was typed and its error. */
  readonly renew: () => void
}

/** Section marks for `id`, wired to the draft. */
export function MarksFor({ ctx, section, title }: { readonly ctx: SectionContext; readonly section: Parameters<typeof isOwn>[2]; readonly title: string }) {
  return (
    <SectionMarks
      id={title}
      unsaved={sectionChanged(ctx.base, ctx.edit, section)}
      own={isOwn(ctx.base, ctx.edit, section)}
      follows={ctx.defaultsName}
      isType={ctx.isType}
      onReset={() => {
        ctx.update((e) => resetSection(ctx.base, e, section))
        ctx.renew()
      }}
      resetTitle={`Go back to what ${ctx.defaultsName} says`}
    />
  )
}

/** The text of an assignment's phrase, as typed: trimmed, spaces collapsed. */
const asTyped = (text: string) => text.trim().replace(/\s+/g, " ")

/** The list and "Answers without a phrase" are two keys of the settings, but one section of the page. */
const withAssign = (ctx: SectionContext, partial: { readonly assistants?: ReadonlyArray<Assignment>; readonly withoutPhrase?: WithoutPhrase }) =>
  ctx.update((e) => setKeys(ctx.base, e, { assistants: partial.assistants ?? ctx.settings.assistants, withoutPhrase: partial.withoutPhrase ?? ctx.settings.withoutPhrase }))

/** Take `id` out of the list; who answered without a phrase there goes with it (as the server does on a delete). */
const removed = (s: DeviceSettings, id: string): { readonly assistants: ReadonlyArray<Assignment>; readonly withoutPhrase: WithoutPhrase } => {
  const assistants = s.assistants.filter((a) => a.assistant !== id)
  const wp = s.withoutPhrase
  const withoutPhrase: WithoutPhrase = wp.mode === "assistant" && wp.assistant === id
    ? { mode: "nobody" }
    : wp.mode === "typesafe" && wp.fallback === id
    ? { ...wp, fallback: assistants[0]?.assistant ?? null }
    : wp
  return { assistants, withoutPhrase }
}

export function AssignSection({ ctx, assistants, canAuto, hasRouting, serverError }: {
  readonly ctx: SectionContext
  readonly assistants: ReadonlyArray<AssistantInfo>
  /** TypeSafe is set up (the server's `canAuto`). */
  readonly canAuto: boolean
  /** The server has a Routing page to link to. */
  readonly hasRouting: boolean
  readonly serverError: string | undefined
}) {
  const s = ctx.settings
  const list = s.assistants
  const wp = s.withoutPhrase
  const byId = new Map(assistants.map((a) => [a.id, a]))
  const sections = useClientState((st) => st.sections)
  const label = hearingModelNames(sections).hearing
  const nameOf = (id: string) => byId.get(id)?.name ?? id
  const hearer = hearerId(s)
  const hearerAssistant = hearer === null ? undefined : byId.get(hearer)
  const unassigned = assistants.filter((a) => !list.some((x) => x.assistant === a.id))
  const [toAdd, setToAdd] = useState("")
  const add = toAdd !== "" && unassigned.some((a) => a.id === toAdd) ? toAdd : unassigned[0]?.id ?? ""
  const dg = useValueDraft("giveUp", wp.mode === "typesafe" ? wp.giveUpMs : TYPESAFE_GIVE_UP_MS.default, (v) => {
    if (wp.mode === "typesafe") withAssign(ctx, { withoutPhrase: { ...wp, giveUpMs: v as number } })
  }, ctx.setBlocked)

  const choice = wp.mode === "nobody" ? "" : wp.mode === "assistant" ? wp.assistant : "typesafe"
  const choose = (value: string) => {
    if (value === "") return withAssign(ctx, { withoutPhrase: { mode: "nobody" } })
    if (value === "typesafe") {
      const previous = wp.mode === "typesafe" ? wp : undefined
      return withAssign(ctx, { withoutPhrase: { mode: "typesafe", fallback: previous?.fallback ?? list[0]?.assistant ?? null, giveUpMs: previous?.giveUpMs ?? TYPESAFE_GIVE_UP_MS.default } })
    }
    withAssign(ctx, { withoutPhrase: { mode: "assistant", assistant: value } })
  }
  const typesafe = wp.mode === "typesafe"
  const alwaysHelp = typesafe
    ? "For a sentence without a phrase, TypeSafe chooses the assistant whose “Handles” fits it best. A wake phrase always wins, and during an assistant’s follow-up time the next sentence stays with it."
    : wp.mode === "assistant"
    ? `${nameOf(wp.assistant)} answers whatever is said, without a phrase. The others wait for their phrase; after a reply and the follow-up time, ${ctx.thisWord} go${ctx.isType ? "" : "es"} back to ${nameOf(wp.assistant)}.`
    : `Every assistant here waits for its phrase. After a reply and the follow-up time, ${ctx.thisWord} sleep${ctx.isType ? "" : "s"} again.`

  const notices = list.filter((e) => hearerAssistant !== undefined && e.assistant !== hearer && byId.get(e.assistant) !== undefined && !sameRecogniser(byId.get(e.assistant)!, hearerAssistant))

  return (
    <section className="flex flex-col gap-5" aria-labelledby="h-assign" data-testid="section-assign">
      <div className="flex items-baseline gap-2">
        <h3 id="h-assign" className="label text-ink-faint">Assistants here</h3>
        <MarksFor ctx={ctx} section="assign" title="Assistants here" />
      </div>
      <p className="text-[14px] text-ink-muted">
        Who answers on {ctx.thisWord}, and which phrase wakes each one. Assistants themselves are made under{" "}
        <a href={formatSettingsHash(["assistants"])} className="text-voice underline-offset-4 hover:underline">Assistants</a>.
      </p>
      {serverError !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="assign-error">{serverError}</p>}
      <DField
        label="Answers without a phrase"
        htmlFor="without-phrase"
        help={
          <>
            {alwaysHelp}
            {!canAuto && (
              <span className="mt-1.5 block" data-testid="typesafe-unavailable">
                Choosing whichever fits needs TypeSafe, which is not set up.
                {hasRouting && <> Set it up in <a href={formatSettingsHash(["shared", "routing"])} className="text-voice underline-offset-4 hover:underline">Shared settings › Routing</a>.</>}
              </span>
            )}
          </>
        }
      >
        <select
          id="without-phrase"
          value={choice}
          onChange={(e) => choose(e.target.value)}
          className={cx(inputClass, selectClass, "max-w-[360px]")}
          style={SELECT_STYLE}
          data-testid="without-phrase"
        >
          <option value="">Nobody: wait for a phrase</option>
          {list.map((e) => <option key={e.assistant} value={e.assistant}>{nameOf(e.assistant)}</option>)}
          <option value="typesafe" disabled={!canAuto && !typesafe}>The one that fits: TypeSafe decides{!canAuto ? " (not set up)" : ""}</option>
        </select>
      </DField>
      {typesafe && !canAuto && (
        <Callout tone="warn" testId="typesafe-callout">
          <p>
            TypeSafe is not set up
            {hasRouting && <>: set it up in <a href={formatSettingsHash(["shared", "routing"])} className="text-voice underline-offset-4 hover:underline">Shared settings › Routing</a> first</>}. Until then, nobody answers without a phrase here.
          </p>
        </Callout>
      )}
      {typesafe && canAuto && wp.mode === "typesafe" && (
        <div className="flex flex-col gap-5 border-l-2 border-line pl-4" data-testid="typesafe-box">
          <DField
            label="If none fits"
            htmlFor="typesafe-fallback"
            help={wp.fallback !== null ? `${nameOf(wp.fallback)} answers when no assistant fits, and when TypeSafe cannot be reached or is too slow.` : "When no assistant fits, or TypeSafe cannot be reached or is too slow, the sentence is ignored."}
          >
            <select
              id="typesafe-fallback"
              value={wp.fallback ?? ""}
              onChange={(e) => withAssign(ctx, { withoutPhrase: { ...wp, fallback: e.target.value === "" ? null : e.target.value } })}
              className={cx(inputClass, selectClass, "max-w-[300px]")}
              style={SELECT_STYLE}
            >
              {list.map((e) => <option key={e.assistant} value={e.assistant}>{nameOf(e.assistant)}</option>)}
              <option value="">Nobody: stay quiet</option>
            </select>
          </DField>
          <DField label="Give up after" error={dg.localErrors.giveUp} help={`If TypeSafe has not answered by then, it counts as none fits. Default ${TYPESAFE_GIVE_UP_MS.default} ms.`}>
            <NumberControl key={ctx.generation} draft={dg} path="giveUp" min={TYPESAFE_GIVE_UP_MS.min} max={TYPESAFE_GIVE_UP_MS.max} step={50} unit="ms" label="Give up after" />
          </DField>
          <p className="text-[13px] text-ink-muted">What is sent: the sentence as text, with the “Handles” line of each assistant here, to TypeSafe (hosted).</p>
          <p className="text-[13px] text-ink-muted">It adds a short delay before the reply starts, only for sentences without a phrase.</p>
        </div>
      )}
      <div className="flex flex-col gap-2">
        {list.length === 0 ? (
          <div className="rounded-md border border-dashed border-line px-4 py-4 text-[14px] text-ink-muted" data-testid="no-assignments">No assistant here yet. Add one below.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line" data-testid="assignments">
            {list.map((e, i) => (
              <AssignmentRow
                key={e.assistant}
                ctx={ctx}
                index={i}
                assignment={e}
                info={byId.get(e.assistant)}
                hearsWith={hearer === e.assistant}
                recogniser={byId.get(e.assistant) !== undefined ? recogniserWords(byId.get(e.assistant)!, label) : ""}
              />
            ))}
          </ul>
        )}
        <p className="flex items-start gap-1.5 text-[13px] text-ink-muted" data-testid="hearer-help">
          <Icon name="ear" size={13} className="mt-1 shrink-0" />
          <span>{ctx.deviceName} recognises speech before it knows who is meant, so it uses one recogniser for everything: that of the assistant that answers without a phrase, or else the first in this list.</span>
        </p>
      </div>
      {notices.map((e) => (
        <Callout key={e.assistant} testId="hearer-notice">
          <p>
            {ctx.deviceName} hears with {nameOf(hearer!)}’s recogniser ({recogniserWords(hearerAssistant!, label)}). {nameOf(e.assistant)} is set to {recogniserWords(byId.get(e.assistant)!, label)}: that is not used on this device.
          </p>
          <p>To hear with {nameOf(e.assistant)}’s, let it answer without a phrase here, or move it to the top of the list.</p>
        </Callout>
      ))}
      {unassigned.length > 0 && (
        <DField label="Add an assistant" htmlFor="add-assistant">
          <div className="flex max-w-[420px] gap-2">
            <select id="add-assistant" value={add} onChange={(e) => setToAdd(e.target.value)} className={cx(inputClass, selectClass, "min-w-0 flex-1")} style={SELECT_STYLE} aria-label="Assistant to add">
              {unassigned.map((a) => <option key={a.id} value={a.id}>{a.name}{a.purpose !== "" ? `: ${a.purpose}` : ""}</option>)}
            </select>
            <Button onClick={() => add !== "" && withAssign(ctx, { assistants: [...list, { assistant: add, phrases: [] }] })} data-testid="add-assistant">
              <Icon name="plus" size={16} />
              Add
            </Button>
          </div>
        </DField>
      )}
    </section>
  )
}

function AssignmentRow({ ctx, index, assignment: e, info, hearsWith, recogniser }: {
  readonly ctx: SectionContext
  readonly index: number
  readonly assignment: Assignment
  readonly info: AssistantInfo | undefined
  readonly hearsWith: boolean
  readonly recogniser: string
}) {
  const s = ctx.settings
  const list = s.assistants
  const wp = s.withoutPhrase
  const name = info?.name ?? e.assistant
  const always = answersWithoutPhrase(wp, e.assistant)
  const typesafe = wp.mode === "typesafe"
  const unreachable = !always && e.phrases.length === 0 && !typesafe
  const [text, setText] = useState("")
  const [error, setError] = useState<string | undefined>()
  const all = useClientState((st) => st.assistants)
  const nameOf = (id: string) => all.find((a) => a.id === id)?.name ?? id
  const patch = (next: Assignment) => withAssign(ctx, { assistants: list.map((x, j) => (j === index ? next : x)) })
  const move = (by: -1 | 1) => {
    const to = index + by
    if (to < 0 || to >= list.length) return
    const copy = [...list]
    ;[copy[index], copy[to]] = [copy[to]!, copy[index]!]
    withAssign(ctx, { assistants: copy })
  }
  const addPhrase = () => {
    const problem = phraseProblem(text, []) ?? phraseConflict(text, list, nameOf)
    if (problem !== undefined) return setError(problem)
    patch({ ...e, phrases: [...e.phrases, asTyped(text)] })
    setText("")
    setError(undefined)
  }
  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    addPhrase()
  }
  const fu = useValueDraft(`fu-${e.assistant}`, e.followUpSeconds ?? info?.followUpSeconds ?? 0, (v) => patch({ ...e, followUpSeconds: v as number }), ctx.setBlocked)
  const fuOwn = e.followUpSeconds !== undefined
  return (
    <li className="flex flex-col gap-3 px-3 py-3" data-assignment={e.assistant} data-index={index}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex">
          <button type="button" className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40 max-sm:size-11" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => move(-1)} data-testid="move-up">
            <Icon name="back" size={16} className="rotate-90" />
          </button>
          <button type="button" className="inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40 max-sm:size-11" aria-label={`Move ${name} down`} disabled={index === list.length - 1} onClick={() => move(1)} data-testid="move-down">
            <Icon name="back" size={16} className="-rotate-90" />
          </button>
        </span>
        <a href={formatSettingsHash(["assistants", e.assistant])} className="text-[14px] font-medium text-ink underline-offset-4 hover:underline" data-testid="assignment-name">{name}</a>
        {always && <span className="rounded-full border border-warn/40 bg-warn/10 px-2 py-0.5 text-[12px] text-ink" data-testid="mark-without-phrase">Answers without a phrase</span>}
        {typesafe && wp.fallback === e.assistant && <Chip>If none fits</Chip>}
        {hearsWith && (
          <span className="label inline-flex items-center gap-1 text-[10px] text-ink-muted" title="This device recognises speech with this assistant’s settings" data-testid="mark-hears">
            <Icon name="ear" size={12} />
            Hears with this one
          </span>
        )}
        {info !== undefined && !info.on && <Chip>Off</Chip>}
        <Button size="sm" variant="quiet" className="ml-auto" aria-label={`Remove ${name} from ${ctx.deviceName}`} onClick={() => withAssign(ctx, removed(s, e.assistant))} data-testid="remove-assistant">Remove</Button>
      </div>
      <div className="flex flex-col gap-2.5 pl-1">
        {info !== undefined && (
          <span className="text-[13px] text-ink-muted">{info.purpose}{info.purpose !== "" && " "}<span className="font-mono text-[12px] text-ink-faint">· {recogniser}</span></span>
        )}
        {typesafe && info !== undefined && (info.handles !== ""
          ? <span className="text-[12px] text-ink-muted">Handles: {info.handles}</span>
          : <p className="text-[13px] text-warn">No “Handles” text yet, so TypeSafe cannot choose it well. <a className="text-voice underline-offset-4 hover:underline" href={formatSettingsHash(["assistants", e.assistant, "basics"])}>Add it on {name}’s page</a>.</p>)}
        <span className="text-[12px] text-ink-muted">Wake phrases on {ctx.thisWord}</span>
        <div className="flex flex-wrap gap-1.5" data-testid="phrases">
          {e.phrases.length === 0 && <span className="text-[13px] text-ink-faint">No phrase.</span>}
          {e.phrases.map((p, j) => (
            <Pill key={`${p}-${j}`} className="gap-1 pr-1" >
              <span data-phrase={p}>{quoted(p)}</span>
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded-full text-ink-muted hover:bg-surface-2 hover:text-ink max-sm:-my-3 max-sm:-mr-2 max-sm:size-11"
                aria-label={`Remove ${quoted(p)}`}
                onClick={() => patch({ ...e, phrases: e.phrases.filter((_, k) => k !== j) })}
              >
                <Icon name="close" size={12} />
              </button>
            </Pill>
          ))}
        </div>
        {e.phrases.length < WAKE_PHRASES_MAX ? (
          <form onSubmit={submit} className="flex flex-col gap-1.5" data-testid="phrase-form">
            <div className="flex max-w-[420px] gap-2">
              <input
                type="text"
                value={text}
                autoComplete="off"
                placeholder={`Add a phrase, e.g. hey ${name.toLowerCase()}`}
                aria-label={`Add a wake phrase for ${name}`}
                aria-invalid={error !== undefined || undefined}
                onChange={(ev) => {
                  setText(ev.target.value)
                  setError(undefined)
                }}
                className={cx(inputClass, "min-w-0 flex-1")}
                data-testid="phrase-input"
              />
              <Button type="submit" data-testid="phrase-add">
                <Icon name="plus" size={16} />
                Add
              </Button>
            </div>
            {error !== undefined && <p role="alert" className="text-[13px] text-danger" data-testid="phrase-error">{error}</p>}
          </form>
        ) : (
          <p className="text-[13px] text-ink-muted">The list is full ({WAKE_PHRASES_MAX}).</p>
        )}
        <DField
          label="Keep listening after a reply"
          htmlFor={`a-fu-${e.assistant}`}
          error={fu.localErrors[`fu-${e.assistant}`]}
          markers={
            <span className="ml-auto inline-flex items-center gap-2" data-testid="fu-marks">
              {fuOwn ? (
                <>
                  <span className="label rounded-sm border border-ink-faint px-1 text-[11px] leading-[14px] text-ink-muted">Own value</span>
                  <button
                    type="button"
                    className="text-[12px] text-voice underline-offset-4 hover:underline"
                    title={`Back to ${name}’s own setting: ${followUpLabel(info?.followUpSeconds ?? 0)}`}
                    aria-label={`Reset the follow-up of ${name}`}
                    onClick={() => {
                      const { followUpSeconds: _gone, ...rest } = e
                      patch(rest)
                      ctx.renew()
                    }}
                    data-testid="fu-reset"
                  >
                    Reset
                  </button>
                </>
              ) : (
                <span className="text-[12px] text-ink-faint">Follows {name}: {followUpLabel(info?.followUpSeconds ?? 0)}</span>
              )}
            </span>
          }
        >
          <PresetControl key={ctx.generation} draft={fu} path={`fu-${e.assistant}`} presets={FOLLOW_UP} unit="seconds" min={1} max={120} customDefault={10} label={`Keep listening after a reply for ${name}`} />
        </DField>
        {unreachable && <p className="text-[13px] text-warn" data-testid="unreachable">Cannot be reached on this device. Add a phrase, or let it answer without one.</p>}
        {info !== undefined && !info.on && <p className="text-[13px] text-ink-muted">{name} is switched off, so it does not answer anywhere.</p>}
      </div>
    </li>
  )
}
