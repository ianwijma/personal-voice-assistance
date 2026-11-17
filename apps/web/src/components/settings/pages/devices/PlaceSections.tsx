"use client"
import { capabilityWords, type DeviceListInfo, type DevicePlace, type DevicePrivacy, effectiveCapabilities, KNOWN_PRESENT_KINDS, MAX_ROOM_CHARS } from "@pva/protocol"
import { setKeys } from "@/lib/devices.ts"
import { BOUNDARY_NOTE, declaredRows, kindsFor, membersOf, PRIVACY_CHOICES } from "@/lib/place.ts"
import { agoText } from "@/lib/sessions.ts"
import { formatSettingsHash } from "@/lib/settingsTree.ts"
import { useClientState } from "../../../context.tsx"
import { inputClass } from "../../../fields/types.ts"
import { Segmented, Switch } from "../../../ui/controls.tsx"
import { MarksFor, type SectionContext } from "./AssignSection.tsx"
import { Callout, Chip, DField } from "./parts.tsx"

/**
 * The Place and "What it can do" sections of a device page and of a device type's defaults (protocol 11,
 * docs/MODULES-PLAN.md §4 P5). Place is never detected: where the device is, how private it is, and whose data a turn
 * there means. "What it can do" shows what the device last declared (Detected) and the switches that take something
 * away; nothing here can add what the device does not have.
 */

function Toggle({ label, checked, onChange, testId }: { readonly label: string; readonly checked: boolean; readonly onChange: (v: boolean) => void; readonly testId?: string }) {
  return (
    <div className="flex items-center gap-3" data-testid={testId}>
      <Switch checked={checked} onChange={onChange} label={label} />
      <span className="text-[14px] text-ink">{checked ? "On" : "Off"}</span>
    </div>
  )
}

/**
 * Next to every field whose change ends the device's session (privacy, default person, its speaker, screen and kinds):
 * what happens when it is saved. Room, always on, accepts and quiet room have none: they do not end it.
 */
function BoundaryNote({ ctx, testId = "place-boundary-note" }: { readonly ctx: SectionContext; readonly testId?: string }) {
  return (
    <p className="mt-1 text-[12px] text-ink-muted" data-testid={testId}>
      {BOUNDARY_NOTE(ctx.isType)}
    </p>
  )
}

export function PlaceSection({ ctx }: { readonly ctx: SectionContext }) {
  const place = ctx.settings.place
  const people = useClientState((s) => membersOf(s.sections), (a, b) => JSON.stringify(a) === JSON.stringify(b))
  const set = (patch: Partial<DevicePlace>) => ctx.update((e) => setKeys(ctx.base, e, { place: { ...place, ...patch } }))
  const missing = place.defaultPerson !== null && !people.some((p) => p.id === place.defaultPerson)
  const privacyHelp = PRIVACY_CHOICES.find((c) => c.value === place.privacy)?.help
  return (
    <section className="flex flex-col gap-5" aria-labelledby="h-place" data-testid="section-place">
      <div className="flex items-baseline gap-2">
        <h3 id="h-place" className="label text-ink-faint">Place</h3>
        <MarksFor ctx={ctx} section="place" title="Place" />
      </div>
      <p className="-mt-3 text-[13px] text-ink-muted">Where {ctx.thisWord} {ctx.isType ? "are" : "is"} and who uses {ctx.isType ? "them" : "it"}. Nothing here is detected; modules and the other devices read it.</p>
      <DField label="Room" htmlFor="place-room" help="Free text, such as Kitchen. Devices with the same room are together; Home Assistant matches it to an area by name.">
        <input
          id="place-room"
          value={place.room}
          maxLength={MAX_ROOM_CHARS}
          placeholder="Kitchen"
          onChange={(e) => set({ room: e.target.value })}
          className={inputClass}
          data-testid="place-room"
        />
      </DField>
      <DField label="Who may see and hear personal things here" help={privacyHelp}>
        <Segmented<DevicePrivacy>
          name="privacy"
          label="Who may see and hear personal things here"
          value={place.privacy}
          onChange={(v) => set({ privacy: v })}
          options={PRIVACY_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
          testId="seg-privacy"
        />
        <BoundaryNote ctx={ctx} />
      </DField>
      <DField
        label="Default person"
        htmlFor="place-person"
        help={<>Whose data a turn here means: “my list” on Sam’s phone is Sam’s. It chooses whose; it never grants access. People are added under <a className="text-voice underline-offset-4 hover:underline" href={formatSettingsHash(["shared", "members"])}>Shared settings › Members</a>.</>}
        {...(missing ? { error: "That person is no longer in Members: pick another, or nobody." } : {})}
      >
        <select
          id="place-person"
          className={inputClass}
          value={place.defaultPerson ?? ""}
          onChange={(e) => set({ defaultPerson: e.target.value === "" ? null : e.target.value })}
          data-testid="place-person"
        >
          <option value="">Nobody: household data</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          {missing && <option value={place.defaultPerson!}>Removed person</option>}
        </select>
        <BoundaryNote ctx={ctx} />
      </DField>
      <DField label="Always on" help="A wall tablet or a speaker that stays on, rather than a tab opened now and then. Things sent here wait for it less.">
        <Toggle label="Always on" checked={place.alwaysOn} onChange={(v) => set({ alwaysOn: v })} testId="place-always-on" />
      </DField>
      <DField label="Accepts things from other devices" help="Other devices may send a card, a list or an announcement here.">
        <Toggle label="Accepts things from other devices" checked={place.acceptsFromOthers} onChange={(v) => set({ acceptsFromOthers: v })} testId="place-accepts" />
      </DField>
      <DField label="Quiet room" help="Nothing that nobody here asked for is spoken here: announcements and reminders from elsewhere stay silent.">
        <Toggle label="Quiet room" checked={place.quietRoom} onChange={(v) => set({ quietRoom: v })} testId="place-quiet" />
      </DField>
    </section>
  )
}

export function CapabilitiesSection({ ctx, device, now, typeKind }: {
  readonly ctx: SectionContext
  readonly device: DeviceListInfo | undefined
  readonly now: number
  /** A device type's page: its kind (its devices' declarations offer their kinds). */
  readonly typeKind?: string
}) {
  const overrides = ctx.settings.capabilities
  const set = (patch: Partial<typeof overrides>) => ctx.update((e) => setKeys(ctx.base, e, { capabilities: { ...overrides, ...patch } }))
  const declared = device?.declared
  const rows = declared === undefined ? [] : declaredRows(declared.capabilities)
  const devices = useClientState((s) => s.devices)
  // The kinds a switch is offered for: the ones the protocol knows, what this device (or any device of this type)
  // declared, and what is excluded already, so an exclusion can always be taken back and made again.
  const kinds = kindsFor({ known: KNOWN_PRESENT_KINDS, declared: device !== undefined ? [device] : devices.filter((d) => d.kind === typeKind), excluded: overrides.excludeKinds })
  const effective = declared === undefined ? undefined : effectiveCapabilities(declared.capabilities, overrides)
  return (
    <section className="flex flex-col gap-5" aria-labelledby="h-caps" data-testid="section-capabilities">
      <div className="flex items-baseline gap-2">
        <h3 id="h-caps" className="label text-ink-faint">What it can do</h3>
        <MarksFor ctx={ctx} section="capabilities" title="What it can do" />
      </div>
      {device !== undefined && (
        declared === undefined
          ? <Callout testId="caps-undeclared">Not declared yet. The voice page says what it can do the next time it connects.</Callout>
          : (
            <div className="flex flex-col gap-2" data-testid="caps-declared">
              <p className="text-[13px] text-ink-muted">
                <Chip testId="detected-chip">Detected</Chip> <span data-testid="caps-seen">{device.connections > 0 ? "Connected now" : "Last seen"}, declared {agoText(declared.seenAt, now)}</span>
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
                {rows.map((r) => (
                  <div key={r.label} className="contents" data-testid={`caps-row-${r.key}`}>
                    <dt className="text-ink-muted">{r.label}</dt>
                    <dd className={r.has ? "text-ink" : "text-ink-faint"}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )
      )}
      <p className="text-[13px] text-ink-muted">You can only take things away here: a phone used as a speaker can be treated as having no screen, but nothing can be given a screen or a speaker it does not have.</p>
      <DField label="Use its screen" help={overrides.noDisplay ? "Treated as having no screen: nothing is shown here, and the assistant is told so." : "Things may be shown here when it has a screen."}>
        <Toggle label="Use its screen" checked={!overrides.noDisplay} onChange={(v) => set({ noDisplay: !v })} testId="caps-display" />
        <BoundaryNote ctx={ctx} testId="caps-boundary-note" />
      </DField>
      <DField
        label="Use its speaker"
        help={overrides.noSpeaker
          ? "Treated as having no speaker: no reply is sent here to be played, spoken or typed, whatever the page says it has."
          : "Replies and announcements may be spoken here when it has a speaker."}
      >
        <Toggle label="Use its speaker" checked={!overrides.noSpeaker} onChange={(v) => set({ noSpeaker: !v })} testId="caps-speaker" />
        <BoundaryNote ctx={ctx} testId="caps-boundary-note" />
      </DField>
      <DField label="What it may show">
        {kinds.length === 0
          ? <p className="text-[13px] text-ink-faint" data-testid="caps-kinds-none">None yet: kinds of things to show arrive with the presentation stage.</p>
          : (
          <div className="flex flex-col gap-2" data-testid="caps-kinds">
            {kinds.map((k) => (
              <div key={k} className="flex items-center gap-3">
                <Switch
                  checked={!overrides.excludeKinds.includes(k)}
                  onChange={(v) => set({ excludeKinds: v ? overrides.excludeKinds.filter((x) => x !== k) : [...overrides.excludeKinds, k].sort() })}
                  label={`Show ${k}`}
                />
                <span className="text-[14px] text-ink">{k}</span>
              </div>
            ))}
          </div>
          )}
        {kinds.length > 0 && <BoundaryNote ctx={ctx} testId="caps-boundary-note" />}
      </DField>
      {effective !== undefined && (
        <p className="text-[13px] text-ink-muted" data-testid="caps-effective">The assistant is told: {capabilityWords(effective)}.</p>
      )}
    </section>
  )
}
