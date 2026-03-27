#!/usr/bin/env node

import { copyFileSync, mkdirSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

function resolvePluginsDir() {
  const args = process.argv.slice(2)
  const pluginsDirFlag = args.indexOf("--plugins-dir")
  if (pluginsDirFlag !== -1 && args[pluginsDirFlag + 1]) {
    return path.resolve(args[pluginsDirFlag + 1])
  }
  const opencodeDirFlag = args.indexOf("--opencode-dir")
  if (opencodeDirFlag !== -1 && args[opencodeDirFlag + 1]) {
    return path.resolve(args[opencodeDirFlag + 1], "plugins")
  }
  return path.join(os.homedir(), ".config", "opencode", "plugins")
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, "..")
const sourceDir = path.join(repoRoot, "examples", "opencode")
const pluginsDir = resolvePluginsDir()

const files = readdirSync(sourceDir)
  .filter((entry) => entry.endsWith(".js"))
  .sort()

mkdirSync(pluginsDir, { recursive: true })

for (const file of files) {
  copyFileSync(path.join(sourceDir, file), path.join(pluginsDir, file))
}

process.stdout.write(`Synced ${files.length} OpenCode bridge file(s) to ${pluginsDir}\n`)
process.stdout.write("Oracle config lives in ~/.oracle/config.json; merge changes from examples/opencode/oracle-config.json5 when needed.\n")
