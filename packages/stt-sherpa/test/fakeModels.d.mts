export declare const FRAME: number
export declare const fakeVad: () => unknown
export declare const fakeOnline: (counters?: { framesDecoded: number; streams: number }) => { readonly counters: { framesDecoded: number; streams: number } }
export declare const fakeOffline: (options?: {
  text?: string
  decodeMs?: number
  hang?: { on: boolean }
  calls?: { started: number; samples: Array<number> }
}) => { readonly hang: { on: boolean; release?: () => void }; readonly calls: { started: number; samples: Array<number> } }
