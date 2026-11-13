import type { ClientMessageOf, OutputPath as ProtocolOutputPath } from "@pva/protocol"

export type AudioClientInfo = ClientMessageOf<"audio.claim">["audio"]
export type OutputPath = ProtocolOutputPath
