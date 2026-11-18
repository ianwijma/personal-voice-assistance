// docs/MODULES.md quotes compiled code: each `<!-- region: <file>#<name> -->` is followed by a ```ts block that must be
// exactly the region `// #region <name>` … `// #endregion <name>` of that file (dedented). Run with PVA_UPDATE_DOCS=1
// to write the blocks from the files after changing one.
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(import.meta.dirname, "..", "..", "..")
const guide = join(root, "docs", "MODULES.md")
const MARK = /<!-- region: ([^#\s]+)#([a-z0-9-]+) -->\n```ts\n([\s\S]*?)```/g

const regionOf = (file: string, name: string): string => {
  const lines = readFileSync(join(root, file), "utf8").split("\n")
  const start = lines.findIndex((l) => l.trim() === `// #region ${name}`)
  const end = lines.findIndex((l, i) => i > start && l.trim() === `// #endregion ${name}`)
  if (start < 0 || end < 0) throw new Error(`${file} has no region ${name}`)
  const body = lines.slice(start + 1, end).filter((l) => !/^\s*\/\/ #(end)?region /.test(l))
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length))
  return `${body.map((l) => l.slice(indent)).join("\n")}\n`
}

/** Every ```ts block of `text`, and whether the line before it is a region marker. */
const tsBlocks = (text: string) => {
  const lines = text.split("\n")
  return lines.flatMap((line, i) => (line.trim() === "```ts" ? [{ line: i + 1, marked: /^<!-- region: [^#\s]+#[a-z0-9-]+ -->$/.test(lines[i - 1] ?? "") }] : []))
}

describe("docs/MODULES.md", () => {
  it("quotes every TypeScript block from a region of a test or source file", () => {
    const blocks = tsBlocks(readFileSync(guide, "utf8"))
    expect(blocks.length).toBeGreaterThan(10)
    expect(blocks.filter((b) => !b.marked).map((b) => `line ${b.line}`)).toEqual([])
    // The check itself: a block without its marker is found.
    expect(tsBlocks("text\n```ts\nconst x = 1\n```\n")).toEqual([{ line: 2, marked: false }])
  })


  it("quotes the regions of the files it names, exactly", () => {
    const text = readFileSync(guide, "utf8")
    const marks = [...text.matchAll(MARK)]
    expect(marks.length).toBeGreaterThan(10)
    if (process.env.PVA_UPDATE_DOCS === "1") {
      writeFileSync(guide, text.replace(MARK, (_whole, file: string, name: string) => `<!-- region: ${file}#${name} -->\n\`\`\`ts\n${regionOf(file, name)}\`\`\``))
      return
    }
    for (const [, file, name, quoted] of marks) expect(quoted, `${file}#${name}`).toBe(regionOf(file!, name!))
  })
})
