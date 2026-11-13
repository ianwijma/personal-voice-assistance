import type { SVGProps } from "react"

/** A small set of line icons (1.5 px strokes, 20 px box), drawn for this UI. */
const paths = {
  mic: <><rect x="7.25" y="2.75" width="5.5" height="9.5" rx="2.75" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.25" /></>,
  micOff: <><path d="M12.75 8.6V5.5a2.75 2.75 0 0 0-5.3-1.03M7.25 7.5v2a2.75 2.75 0 0 0 4.4 2.2M15.5 9.5a5.48 5.48 0 0 1-.7 2.7M4.5 9.5a5.5 5.5 0 0 0 8.6 4.54M10 15v2.25M3 3l14 14" /></>,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />,
  chat: <><path d="M3.75 5.75a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9.5l-3.25 2.75v-2.75h-.5a2 2 0 0 1-2-2z" /><path d="M7 8.25h6M7 10.75h3.5" /></>,
  gear: <><circle cx="10" cy="10" r="2.5" /><path d="M10 2.75v2M10 15.25v2M17.25 10h-2M4.75 10h-2M15.13 4.87l-1.42 1.42M6.29 13.71l-1.42 1.42M15.13 15.13l-1.42-1.42M6.29 6.29 4.87 4.87" /></>,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  lock: <><rect x="4.75" y="9" width="10.5" height="7.75" rx="1.5" /><path d="M7 9V6.75a3 3 0 0 1 6 0V9" /></>,
  keyboard: <><rect x="2.75" y="5.25" width="14.5" height="9.5" rx="1.5" /><path d="M5.75 8.25h.01M8.25 8.25h.01M10.75 8.25h.01M13.25 8.25h.01M6.5 11.5h7" /></>,
  chevron: <path d="M7.5 5l5 5-5 5" />,
  chevronDown: <path d="M5 7.5l5 5 5-5" />,
  check: <path d="M4.5 10.5l3.5 3.5 7.5-8" />,
  cross: <path d="M6 6l8 8M14 6l-8 8" />,
  bolt: <path d="M11 2.75 4.75 11h4.5l-1 6.25L14.5 9H10z" />,
  arrowDown: <path d="M10 4v12M5 11l5 5 5-5" />,
  send: <path d="M10 16V4M5 9l5-5 5 5" />,
  speaker: <><path d="M3.75 7.75h2.5L10 4.5v11l-3.75-3.25h-2.5z" /><path d="M13 7.5a3.5 3.5 0 0 1 0 5M15 5.5a6.5 6.5 0 0 1 0 9" /></>,
  speakerOff: <><path d="M3.75 7.75h2.5L10 4.5v11l-3.75-3.25h-2.5z" /><path d="M13 8l4 4M17 8l-4 4" /></>,
  reload: <><path d="M15.5 6.5A6.25 6.25 0 1 0 16.25 11" /><path d="M16 3v3.75h-3.75" /></>,
  wrench: <path d="M12.5 3.25a3.75 3.75 0 0 0-3.4 5.33L3.75 13.9a1.5 1.5 0 0 0 2.12 2.12l5.33-5.33a3.75 3.75 0 0 0 5.03-4.35l-2.2 2.2-2.12-.53-.53-2.12 2.2-2.2a3.75 3.75 0 0 0-1.08-.44z" />
} as const

export type IconName = keyof typeof paths

export function Icon({ name, size = 20, ...rest }: { readonly name: IconName; readonly size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}

export function Spinner({ size = 14, className = "" }: { readonly size?: number; readonly className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className={`spin-keep animate-[pva-spin_0.9s_linear_infinite] ${className}`}>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
