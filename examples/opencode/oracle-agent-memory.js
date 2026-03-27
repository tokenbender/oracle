import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const MEMORY_SCHEMA_VERSION = 1
const MAX_SEARCH_TEXT_CHARS = 12000

const COMMAND_PREFIXES = [
  "bun ",
  "npm ",
  "pnpm ",
  "yarn ",
  "node ",
  "python ",
  "python3 ",
  "git ",
  "oracle ",
  "npx ",
  "tsx ",
  "vitest ",
  "pytest ",
  "cargo ",
  "go ",
  "make ",
  "bash ",
  "sh ",
]

const SYMBOL_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "answer",
  "attached",
  "before",
  "browser",
  "build",
  "bundle",
  "change",
  "changes",
  "check",
  "code",
  "config",
  "context",
  "current",
  "default",
  "details",
  "directory",
  "docs",
  "engine",
  "error",
  "false",
  "file",
  "files",
  "final",
  "follow",
  "history",
  "issue",
  "local",
  "memory",
  "message",
  "messages",
  "model",
  "oracle",
  "output",
  "plugin",
  "profile",
  "project",
  "prompt",
  "query",
  "recent",
  "repo",
  "session",
  "state",
  "summary",
  "system",
  "task",
  "text",
  "tool",
  "tools",
  "true",
  "update",
  "user",
  "using",
  "work",
  "worktree",
])

const CONSTRAINT_PATTERN = /\b(must|must not|do not|don't|never|only|required|constraint|preserve|keep)\b/i
const DECISION_PATTERN = /\b(decid(?:e|ed|ing)|prefer|use|choose|chosen|select|selected|adopt|stick with|defer)\b/i
const OPEN_QUESTION_PATTERN = /\b(todo|next step|follow up|remaining|pending|later|investigate|need to|still need|plan)\b/i
const PATH_PATTERN = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z]{2,10}/g
const FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "mjs",
  "md",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "yaml",
  "yml",
])

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function truncateText(text, max) {
  if (!text || text.length <= max) return text
  return text.slice(0, max)
}

function stableHash(value) {
  return createHash("sha1").update(value).digest("hex")
}

function addUnique(list, seen, value, maxItems = Infinity) {
  const normalized = normalizeText(value)
  if (!normalized || list.length >= maxItems) return
  const key = normalized.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  list.push(normalized)
}

function relPath(targetPath, worktree) {
  if (!targetPath) return ""
  if (!worktree || !path.isAbsolute(targetPath)) return targetPath
  const relative = path.relative(worktree, targetPath)
  if (!relative || relative.startsWith("..")) return targetPath
  return relative
}

function decodeFileUrl(url) {
  if (!url || !url.startsWith("file://")) return null
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function fileUrlToPath(url) {
  const parsed = decodeFileUrl(url)
  if (!parsed) return null
  const pathname = decodeURIComponent(parsed.pathname)
  if (process.platform === "win32" && pathname.startsWith("/")) {
    return pathname.slice(1)
  }
  return pathname
}

function cleanPathCandidate(value) {
  const candidate = normalizeText(value).replace(/^[`'"(\[]+|[`'"),.;:\]]+$/g, "")
  if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) return ""
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    const extension = path.extname(candidate).slice(1).toLowerCase()
    if (!FILE_EXTENSIONS.has(extension)) return ""
  }
  return candidate
}

function addPath(paths, seen, candidate, worktree, maxItems = 48) {
  const cleaned = cleanPathCandidate(candidate)
  if (!cleaned) return
  const maybeRelative = relPath(cleaned, worktree)
  addUnique(paths, seen, maybeRelative, maxItems)
}

function looksLikeSymbol(token) {
  if (!token || token.length < 3) return false
  const lower = token.toLowerCase()
  if (SYMBOL_STOP_WORDS.has(lower)) return false
  return /[_$]/.test(token) || /[a-z][A-Z]/.test(token) || /^[A-Z][A-Za-z0-9]+$/.test(token)
}

function addSymbolsFromText(symbols, seen, text, maxItems = 64) {
  const matches = String(text ?? "").match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) ?? []
  for (const token of matches) {
    if (!looksLikeSymbol(token)) continue
    addUnique(symbols, seen, token, maxItems)
    if (symbols.length >= maxItems) return
  }
}

function addSymbolsFromPath(symbols, seen, filePath, maxItems = 64) {
  const cleaned = cleanPathCandidate(filePath)
  if (!cleaned) return
  const base = path.basename(cleaned).replace(/\.[^.]+$/, "")
  addSymbolsFromText(symbols, seen, base, maxItems)
}

function addPathCandidatesFromText(paths, pathSeen, symbols, symbolSeen, text, worktree) {
  const matches = String(text ?? "").match(PATH_PATTERN) ?? []
  for (const match of matches) {
    addPath(paths, pathSeen, match, worktree)
    addSymbolsFromPath(symbols, symbolSeen, match)
  }
}

function looksLikeShellCommand(text) {
  const normalized = normalizeText(text)
  if (!normalized) return false
  if (normalized.includes(" && ") || normalized.includes(" || ") || normalized.includes(" | ")) return true
  return COMMAND_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function collectCommands(commands, seen, value, keyHint = "", maxItems = 24) {
  if (value == null || commands.length >= maxItems) return
  if (typeof value === "string") {
    const normalized = normalizeText(value)
    if (keyHint === "command" || keyHint === "cmd" || keyHint === "script" || looksLikeShellCommand(normalized)) {
      addUnique(commands, seen, normalized, maxItems)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCommands(commands, seen, item, keyHint, maxItems)
      if (commands.length >= maxItems) return
    }
    return
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectCommands(commands, seen, nested, key, maxItems)
      if (commands.length >= maxItems) return
    }
  }
}

function addSearchFragment(fragments, text) {
  const normalized = normalizeText(text)
  if (!normalized) return
  fragments.push(truncateText(normalized, 600))
}

function addStructuredSignals(bucket, text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
  for (const line of lines) {
    if (line.length < 10 || line.length > 260) continue
    if (CONSTRAINT_PATTERN.test(line)) {
      addUnique(bucket.constraints, bucket.constraintSeen, line, 16)
    }
    if (DECISION_PATTERN.test(line)) {
      addUnique(bucket.decisions, bucket.decisionSeen, line, 16)
    }
    if (OPEN_QUESTION_PATTERN.test(line)) {
      addUnique(bucket.openQuestions, bucket.openQuestionSeen, line, 16)
    }
  }
}

function addError(errors, seen, value, maxItems = 16) {
  const normalized = normalizeText(value)
  if (!normalized) return
  addUnique(errors, seen, truncateText(normalized, 400), maxItems)
}

function addTimestamp(timestampRange, value) {
  const normalized = normalizeText(value)
  if (!normalized) return
  if (!timestampRange.start || normalized < timestampRange.start) timestampRange.start = normalized
  if (!timestampRange.end || normalized > timestampRange.end) timestampRange.end = normalized
}

function buildSearchText(fragments, fields) {
  const joined = [...fragments, ...fields].map((item) => normalizeText(item)).filter(Boolean).join("\n")
  return truncateText(joined, MAX_SEARCH_TEXT_CHARS)
}

function makeSessionArtifact({ session, entries, worktree }) {
  const files = []
  const fileSeen = new Set()
  const symbols = []
  const symbolSeen = new Set()
  const commands = []
  const commandSeen = new Set()
  const errors = []
  const errorSeen = new Set()
  const decisions = []
  const decisionSeen = new Set()
  const constraints = []
  const constraintSeen = new Set()
  const openQuestions = []
  const openQuestionSeen = new Set()
  const messageIds = []
  const messageIdSeen = new Set()
  const searchFragments = []
  const timestampRange = { start: null, end: null }

  const signalBucket = {
    decisions,
    decisionSeen,
    constraints,
    constraintSeen,
    openQuestions,
    openQuestionSeen,
  }

  for (const entry of entries ?? []) {
    if (entry?.info?.id) addUnique(messageIds, messageIdSeen, entry.info.id, Infinity)
    addTimestamp(timestampRange, entry?.info?.createdAt)
    addTimestamp(timestampRange, entry?.info?.updatedAt)
    addTimestamp(timestampRange, entry?.info?.time)

    if (entry?.info?.summary?.title) {
      addSearchFragment(searchFragments, entry.info.summary.title)
      addStructuredSignals(signalBucket, entry.info.summary.title)
    }
    if (entry?.info?.summary?.body) {
      addSearchFragment(searchFragments, entry.info.summary.body)
      addStructuredSignals(signalBucket, entry.info.summary.body)
      addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, entry.info.summary.body, worktree)
      addSymbolsFromText(symbols, symbolSeen, entry.info.summary.body)
    }
    for (const diff of entry?.info?.summary?.diffs ?? []) {
      addPath(files, fileSeen, diff.file, worktree)
      addSymbolsFromPath(symbols, symbolSeen, diff.file)
    }

    if (entry?.info?.error) {
      addError(errors, errorSeen, typeof entry.info.error === "string" ? entry.info.error : JSON.stringify(entry.info.error))
    }

    for (const part of entry?.parts ?? []) {
      if (part.type === "text") {
        addSearchFragment(searchFragments, part.text)
        addStructuredSignals(signalBucket, part.text)
        addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, part.text, worktree)
        addSymbolsFromText(symbols, symbolSeen, part.text)
        continue
      }

      if (part.type === "subtask") {
        addSearchFragment(searchFragments, part.description)
        addSearchFragment(searchFragments, part.prompt)
        addStructuredSignals(signalBucket, part.description)
        addStructuredSignals(signalBucket, part.prompt)
        addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, part.prompt, worktree)
        addSymbolsFromText(symbols, symbolSeen, part.prompt)
        continue
      }

      if (part.type === "file") {
        addPath(files, fileSeen, part.source?.path, worktree)
        addPath(files, fileSeen, fileUrlToPath(part.url), worktree)
        addPath(files, fileSeen, part.filename, worktree)
        addSymbolsFromPath(symbols, symbolSeen, part.source?.path ?? part.filename ?? part.url)
        continue
      }

      if (part.type === "patch") {
        for (const file of part.files ?? []) {
          addPath(files, fileSeen, file, worktree)
          addSymbolsFromPath(symbols, symbolSeen, file)
        }
        continue
      }

      if (part.type === "tool") {
        addSearchFragment(searchFragments, part.tool)
        addSearchFragment(searchFragments, part.state?.title)
        collectCommands(commands, commandSeen, part.state?.input)
        if (part.state?.input) {
          const serializedInput = JSON.stringify(part.state.input)
          addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, serializedInput, worktree)
          addSymbolsFromText(symbols, symbolSeen, serializedInput)
        }
        if (part.state?.output) {
          const outputPreview = truncateText(String(part.state.output), 4000)
          addSearchFragment(searchFragments, outputPreview)
          addPathCandidatesFromText(files, fileSeen, symbols, symbolSeen, outputPreview, worktree)
          addSymbolsFromText(symbols, symbolSeen, outputPreview)
          addStructuredSignals(signalBucket, outputPreview)
        }
        if (part.state?.error) {
          addError(errors, errorSeen, part.state.error)
          addStructuredSignals(signalBucket, part.state.error)
        }
        for (const attachment of part.state?.attachments ?? []) {
          addPath(files, fileSeen, attachment.source?.path, worktree)
          addPath(files, fileSeen, fileUrlToPath(attachment.url), worktree)
        }
        continue
      }

      if (part.type === "retry") {
        addError(errors, errorSeen, typeof part.error === "string" ? part.error : JSON.stringify(part.error))
        continue
      }

      if (part.type === "agent") {
        addSearchFragment(searchFragments, part.name)
      }
    }
  }

  const searchText = buildSearchText(searchFragments, [
    ...files,
    ...symbols,
    ...commands,
    ...errors,
    ...decisions,
    ...constraints,
    ...openQuestions,
  ])

  const artifact = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sessionId: session.id,
    parentID: session.parentID ?? null,
    title: session.title ?? "",
    directory: session.directory ?? "",
    worktree: worktree ?? session.directory ?? "",
    messageIds,
    timestampRange,
    files,
    symbols,
    commands,
    errors,
    decisions,
    constraints,
    openQuestions,
    searchText,
  }

  return {
    ...artifact,
    sourceFingerprint: stableHash(JSON.stringify(artifact)),
  }
}

function collectRecentUnique(artifacts, key, maxItems) {
  const values = []
  const seen = new Set()
  for (const artifact of [...artifacts].reverse()) {
    for (const value of artifact[key] ?? []) {
      addUnique(values, seen, value, maxItems)
      if (values.length >= maxItems) return values
    }
  }
  return values
}

function formatList(values, maxItems = 8) {
  if (!values.length) return ""
  const visible = values.slice(0, maxItems)
  const suffix = values.length > maxItems ? `, +${values.length - maxItems} more` : ""
  return `${visible.join(", ")}${suffix}`
}

function buildStructuredMemorySection(sessionArtifacts) {
  if (!sessionArtifacts?.length) return []
  const lines = []
  const files = collectRecentUnique(sessionArtifacts, "files", 12)
  const symbols = collectRecentUnique(sessionArtifacts, "symbols", 12)
  const commands = collectRecentUnique(sessionArtifacts, "commands", 8)
  const errors = collectRecentUnique(sessionArtifacts, "errors", 8)
  const decisions = collectRecentUnique(sessionArtifacts, "decisions", 8)
  const constraints = collectRecentUnique(sessionArtifacts, "constraints", 8)
  const openQuestions = collectRecentUnique(sessionArtifacts, "openQuestions", 8)

  lines.push("## Structured session memory")
  lines.push(`- Cached lineage sessions: ${sessionArtifacts.length}`)
  if (files.length) lines.push(`- Notable files: ${formatList(files, 8)}`)
  if (symbols.length) lines.push(`- Notable symbols: ${formatList(symbols, 8)}`)
  if (commands.length) lines.push(`- Commands observed: ${formatList(commands, 6)}`)
  if (errors.length) lines.push(`- Reported errors: ${formatList(errors, 4)}`)
  if (decisions.length) lines.push(`- Decisions: ${formatList(decisions, 4)}`)
  if (constraints.length) lines.push(`- Constraints: ${formatList(constraints, 4)}`)
  if (openQuestions.length) lines.push(`- Open questions: ${formatList(openQuestions, 4)}`)
  lines.push("")

  return lines
}

function getWorktreeCacheDir(oracleHomeDir, worktree) {
  const resolvedWorktree = path.resolve(worktree || process.cwd())
  const rootDir = oracleHomeDir || path.join(os.homedir(), ".oracle")
  return path.join(rootDir, "opencode-memory", stableHash(resolvedWorktree))
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function writeJsonIfChanged(filePath, value) {
  const nextText = `${JSON.stringify(value, null, 2)}\n`
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, "utf8") === nextText) return false
    } catch {
      // fall through
    }
  }
  writeFileSync(filePath, nextText)
  return true
}

function persistSessionArtifacts({ oracleHomeDir, worktree, sessionArtifacts }) {
  const cacheDir = getWorktreeCacheDir(oracleHomeDir, worktree)
  const sessionsDir = path.join(cacheDir, "sessions")
  mkdirSync(sessionsDir, { recursive: true })

  let writes = 0
  for (const artifact of sessionArtifacts) {
    if (writeJsonIfChanged(path.join(sessionsDir, `${artifact.sessionId}.json`), artifact)) {
      writes += 1
    }
  }

  const manifestPath = path.join(cacheDir, "manifest.json")
  const previousManifest = readJsonIfExists(manifestPath)
  const manifest = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    worktree: path.resolve(worktree || process.cwd()),
    updatedAt: new Date().toISOString(),
    sessionCount: sessionArtifacts.length,
    sessions: sessionArtifacts.map((artifact) => ({
      sessionId: artifact.sessionId,
      title: artifact.title,
      sourceFingerprint: artifact.sourceFingerprint,
      messageCount: artifact.messageIds.length,
    })),
  }

  if (
    previousManifest?.schemaVersion === manifest.schemaVersion &&
    JSON.stringify(previousManifest.sessions) === JSON.stringify(manifest.sessions)
  ) {
    manifest.updatedAt = previousManifest.updatedAt
  }

  writeJsonIfChanged(manifestPath, manifest)

  return {
    cacheDir,
    manifestPath,
    sessionCount: sessionArtifacts.length,
    writes,
  }
}

export {
  MEMORY_SCHEMA_VERSION,
  buildStructuredMemorySection,
  getWorktreeCacheDir,
  makeSessionArtifact,
  persistSessionArtifacts,
}
