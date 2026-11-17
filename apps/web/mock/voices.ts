/**
 * The mock's voice providers (docs/VOICE-PROVIDERS.md §3): what each would list. Believable, made-up data: the
 * local presets match the mock's Voices › Models list; the hosted ids are invented (Sarah and Skylar are the
 * adapters' defaults).
 */

export interface MockVoice {
  readonly voiceId: string
  readonly name: string
  readonly description?: string
  readonly language?: string
  readonly gender?: "female" | "male" | "neutral"
  readonly tags: ReadonlyArray<string>
}

export interface MockProvider {
  readonly id: string
  readonly label: string
  readonly location: "local" | "hosted"
  readonly keyField?: string
  readonly implication?: string
  /** The engine the Overview names for a voice of it. */
  readonly engine: (voiceId: string) => string
  readonly voices: ReadonlyArray<MockVoice>
}

export const MOCK_PROVIDERS: ReadonlyArray<MockProvider> = [
  {
    id: "sherpa",
    label: "On this machine",
    location: "local",
    engine: (id) => (id.startsWith("kokoro") ? `Kokoro ${id}` : `Piper ${id}`),
    voices: [
      { voiceId: "en_US-lessac-medium", name: "Lessac", description: "Piper: fast, clear American English.", language: "en-US", gender: "female", tags: ["fast"] },
      { voiceId: "en_GB-alba-medium", name: "Alba", description: "Piper: fast, Scottish-accented English.", language: "en-GB", gender: "female", tags: ["fast"] },
      { voiceId: "nl_NL-pim-medium", name: "Pim", description: "Piper: fast Dutch.", language: "nl-NL", gender: "male", tags: ["fast"] },
      { voiceId: "kokoro-af_heart", name: "Heart", description: "Kokoro: warm and natural; its first audio comes later.", language: "en-US", gender: "female", tags: ["natural", "slow-start"] }
    ]
  },
  {
    id: "cartesia",
    label: "Cartesia",
    location: "hosted",
    keyField: "CARTESIA_API_KEY",
    implication: "Replies are sent to Cartesia to be spoken.",
    engine: () => "Cartesia sonic-3",
    voices: [
      { voiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", name: "Skylar", description: "Friendly, bright and clear.", language: "en", gender: "female", tags: ["pro"] },
      { voiceId: "3f1c2a90-6c1e-4f0b-9a7e-2d8b6e4c1a01", name: "Brooke", description: "Calm and conversational.", language: "en", gender: "female", tags: ["pro"] },
      { voiceId: "7a2d9e14-0b8c-4c55-b1f3-5e6a7d8c9b02", name: "Ronald", description: "Deep, steady narrator.", language: "en", gender: "male", tags: ["pro"] },
      { voiceId: "a90e4c3b-2f7d-4e1a-8c6b-3d4e5f6a7b03", name: "Tessa", description: "Light and quick, for short answers.", language: "en-GB", gender: "female", tags: [] },
      { voiceId: "c4b8e2f1-9d3a-4b7c-a6e5-1f2d3c4b5a04", name: "Joris", description: "Warm Dutch voice.", language: "nl", gender: "male", tags: ["yours"] }
    ]
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    location: "hosted",
    keyField: "ELEVENLABS_API_KEY",
    implication: "Replies are sent to ElevenLabs to be spoken.",
    engine: () => "ElevenLabs eleven_flash_v2_5",
    voices: [
      { voiceId: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "Young adult woman with a confident and warm, mature quality.", language: "en", gender: "female", tags: ["american", "young", "premade"] },
      { voiceId: "mk1Rg0erGV3wq8Hb2Aa1", name: "Roger", description: "Easy going, for casual conversations.", language: "en", gender: "male", tags: ["american", "middle-aged", "premade"] },
      { voiceId: "mk2Ls1fsHW4xr9Ic3Bb2", name: "Charlotte", description: "Warm, slightly husky.", language: "en-GB", gender: "female", tags: ["british", "warm", "premade"] },
      { voiceId: "mk3Mt2gtIX5ys0Jd4Cc3", name: "Daniel", description: "A strong voice for delivering the news.", language: "en-GB", gender: "male", tags: ["british", "news", "premade"] },
      { voiceId: "mk4Nu3huJY6zt1Ke5Dd4", name: "Lily", description: "Velvety and soft.", language: "en-GB", gender: "female", tags: ["british", "narration", "premade"] },
      { voiceId: "mk5Ov4ivKZ7au2Lf6Ee5", name: "Matilda", description: "Professional, with a pleasing alto pitch.", language: "en", gender: "female", tags: ["american", "calm", "premade"] },
      { voiceId: "mk6Pw5jwLA8bv3Mg7Ff6", name: "Callum", description: "Gravelly, with an edge.", language: "en", gender: "male", tags: ["transatlantic", "premade"] },
      { voiceId: "mk7Qx6kxMB9cw4Nh8Gg7", name: "Bill", description: "Friendly and comforting, to narrate stories.", language: "en", gender: "male", tags: ["american", "old", "premade"] },
      { voiceId: "mk8Ry7lyNC0dx5Oi9Hh8", name: "Laura", description: "Sunny enthusiasm.", language: "en", gender: "female", tags: ["american", "young"] },
      { voiceId: "mk9Sz8mzOD1ey6Pj0Ii9", name: "Sanne", description: "Clear Dutch, a cloned voice of this account.", language: "nl", gender: "female", tags: ["cloned"] }
    ]
  }
]

/** A WAV file (PCM 16-bit mono) of these samples. */
export const encodeWav = (pcm: Int16Array, rate: number): Buffer => {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
