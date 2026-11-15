import type { SVGProps } from "react"

/** A small set of line icons (1.5 px strokes, 20 px box), drawn for this UI. */
const paths = {
  mic: <><rect x="7.25" y="2.75" width="5.5" height="9.5" rx="2.75" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.25" /></>,
  micOff: <><path d="M12.75 8.6V5.5a2.75 2.75 0 0 0-5.3-1.03M7.25 7.5v2a2.75 2.75 0 0 0 4.4 2.2M15.5 9.5a5.48 5.48 0 0 1-.7 2.7M4.5 9.5a5.5 5.5 0 0 0 8.6 4.54M10 15v2.25M3 3l14 14" /></>,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />,
  chat: <><path d="M3.75 5.75a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9.5l-3.25 2.75v-2.75h-.5a2 2 0 0 1-2-2z" /><path d="M7 8.25h6M7 10.75h3.5" /></>,
  newChat: <><path d="M3.75 5.75a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9.5l-3.25 2.75v-2.75h-.5a2 2 0 0 1-2-2z" /><path d="M10 6.5v4.5M7.75 8.75h4.5" /></>,
  more: <><circle cx="5" cy="10" r="0.6" fill="currentColor" /><circle cx="10" cy="10" r="0.6" fill="currentColor" /><circle cx="15" cy="10" r="0.6" fill="currentColor" /></>,
  gear: <><circle cx="10" cy="10" r="2.5" /><path d="M8.58 4.48 8.69 2.51h2.62l.11 1.97a5.7 5.7 0 0 1 1.48.61l1.47-1.31 1.85 1.85-1.31 1.47a5.7 5.7 0 0 1 .61 1.48l1.97.11v2.62l-1.97.11a5.7 5.7 0 0 1-.61 1.48l1.31 1.47-1.85 1.85-1.47-1.31a5.7 5.7 0 0 1-1.48.61l-.11 1.97H8.69l-.11-1.97a5.7 5.7 0 0 1-1.48-.61l-1.47 1.31-1.85-1.85 1.31-1.47a5.7 5.7 0 0 1-.61-1.48l-1.97-.11V8.69l1.97-.11a5.7 5.7 0 0 1 .61-1.48L3.78 5.63l1.85-1.85L7.1 5.09a5.7 5.7 0 0 1 1.48-.61z" /></>,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  key: <><circle cx="7" cy="12.5" r="3.25" /><path d="M9.4 10.2 15.75 3.85M13.25 6.35l1.9 1.9M11.5 8.1l1.5 1.5" /></>,
  pin: <><path d="M10 17.25v-5M6.25 12.25h7.5l-1-2.25V5.25l1.25-2.5h-8l1.25 2.5V10z" /></>,
  back: <path d="M12.5 5l-5 5 5 5" />,
  lock: <><rect x="4.75" y="9" width="10.5" height="7.75" rx="1.5" /><path d="M7 9V6.75a3 3 0 0 1 6 0V9" /></>,
  unlock: <><rect x="4.75" y="9" width="10.5" height="7.75" rx="1.5" /><path d="M7 9V6.75a3 3 0 0 1 5.8-1.05" /></>,
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
  trash: <path d="M4.75 6h10.5M8 6V4.25h4V6M6.25 6l.75 10.25h6l.75-10.25M8.75 9v4.5M11.25 9v4.5" />,
  logout: <><path d="M8 4.25H5.25a1.5 1.5 0 0 0-1.5 1.5v8.5a1.5 1.5 0 0 0 1.5 1.5H8" /><path d="M12.5 6.5 16 10l-3.5 3.5M16 10H8" /></>,
  arrowRight: <path d="M4 10h12M11 5l5 5-5 5" />,
  open: <path d="M9 4.75H5.75a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1V11M11.5 4.75h3.75V8.5M15.25 4.75 9.5 10.5" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  ear: <><path d="M6 8a4 4 0 0 1 8 0c0 2.5-2.5 3.25-2.5 5.5a2.5 2.5 0 0 1-4.5 1.5" /><path d="M8.5 8.25a1.5 1.5 0 0 1 3 0" /></>,
  device: <><rect x="5.75" y="2.75" width="8.5" height="14.5" rx="1.75" /><path d="M9 14.5h2" /></>,
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
