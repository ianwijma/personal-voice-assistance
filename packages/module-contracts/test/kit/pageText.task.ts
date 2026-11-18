// The task module of the off-thread example (docs/MODULES.md §15): it runs in a worker thread, never on the main one.
// #region offthread-task
// pageText.task.ts: a page from outside read into text. One pure function, plain data in and out; nothing shared,
// no network, no store. It runs in a fresh worker thread for each call (offThread in the module).
import { parseHTML } from "linkedom"

export default (html: string): string => {
  const { document } = parseHTML(html)
  for (const node of document.querySelectorAll("script, style, noscript")) node.remove()
  return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim()
}
// #endregion offthread-task
