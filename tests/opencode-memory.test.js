import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  buildStructuredMemorySection,
  getWorktreeCacheDir,
  makeSessionArtifact,
  persistSessionArtifacts,
} from "../examples/opencode/oracle-agent-memory.js"

function loadFixture(name) {
  const filePath = fileURLToPath(new URL(`./fixtures/opencode-memory/${name}`, import.meta.url))
  return JSON.parse(readFileSync(filePath, "utf8"))
}

describe("OpenCode memory extraction", () => {
  it("extracts deterministic facts from session history", () => {
    const fixture = loadFixture("session-decision-files.json")
    const artifact = makeSessionArtifact({
      session: fixture.session,
      entries: fixture.entries,
      worktree: fixture.worktree,
    })

    expect(artifact.sessionId).toBe("sess-decision-files")
    expect(artifact.files).toEqual(
      expect.arrayContaining([
        "docs/opencode.md",
        "examples/opencode/oracle-agent.js",
        "docs/query-aware-memory.md",
        "tests/opencode-memory.test.js",
      ]),
    )
    expect(artifact.commands).toEqual(["bun test tests/opencode-memory.test.js"])
    expect(artifact.constraints).toContain("We must preserve maxFileSizeBytes. Use browser.modelStrategy current. Next step: add query aware retrieval for session history.")
    expect(artifact.decisions).toContain("I decided to keep deterministic pruning first and defer LLM summarization.")
    expect(artifact.openQuestions).toContain("We must preserve maxFileSizeBytes. Use browser.modelStrategy current. Next step: add query aware retrieval for session history.")
    expect(artifact.searchText).toContain("query aware retrieval")
    expect(artifact.sourceFingerprint).toMatch(/^[a-f0-9]{40}$/)
  })

  it("persists session artifacts and builds a compact structured summary", () => {
    const first = loadFixture("session-decision-files.json")
    const second = loadFixture("session-errors-cache.json")
    const artifacts = [
      makeSessionArtifact({ session: first.session, entries: first.entries, worktree: first.worktree }),
      makeSessionArtifact({ session: second.session, entries: second.entries, worktree: second.worktree }),
    ]

    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "opencode-memory-test-"))

    try {
      const result = persistSessionArtifacts({
        oracleHomeDir: tempRoot,
        worktree: first.worktree,
        sessionArtifacts: artifacts,
      })

      const cacheDir = getWorktreeCacheDir(tempRoot, first.worktree)
      const manifest = JSON.parse(readFileSync(path.join(cacheDir, "manifest.json"), "utf8"))
      const storedArtifact = JSON.parse(
        readFileSync(path.join(cacheDir, "sessions", "sess-errors-cache.json"), "utf8"),
      )
      const sectionLines = buildStructuredMemorySection(artifacts)
      const section = sectionLines.join("\n")

      expect(result.cacheDir).toBe(cacheDir)
      expect(manifest.sessionCount).toBe(2)
      expect(manifest.sessions.map((session) => session.sessionId)).toEqual([
        "sess-decision-files",
        "sess-errors-cache",
      ])
      expect(storedArtifact.errors).toContain("attached Oracle session context exceeded the 1 MB limit")
      expect(storedArtifact.commands).toContain('git status && oracle --engine browser -p "test"')
      expect(section).toContain("## Structured session memory")
      expect(section).toContain("src/oracle/files.ts")
      expect(section).toContain("prefer browser mode for GPT Pro runs")
      expect(section).toContain("attached Oracle session context exceeded the 1 MB limit")
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
