import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Every test that makes a temporary directory (`mkdtempSync(join(tmpdir(), "pva-…"))`) leaves it behind, which adds up
 * to thousands of directories in /tmp and can use up its inodes. The run gets its own temporary root instead: the test
 * workers inherit `TMPDIR`, so `os.tmpdir()` points there, and the whole root is removed when the run ends.
 */
export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "pva-test-run-"))
  process.env.TMPDIR = root
  return () => {
    rmSync(root, { recursive: true, force: true })
  }
}
