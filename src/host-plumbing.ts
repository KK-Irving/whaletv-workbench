/**
 * Shared plumbing for the whaletv-workbench host half: exec/git helpers,
 * JSON request/response, atomic-ish config paths and package facts. Split
 * out of index.ts in v0.8.0 (P4-25).
 */
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import os from 'node:os'

/** Plugin id — matches the package name and the client bundle graph row. */
const CLIENT_ID = 'whaletv-workbench'

/** This package's root directory (lib/index.js → lib → package root). */

/** This package's root directory (lib/index.js → lib → package root). */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * All workbench routes live under this prefix. One `kind: 'prefix'`
 * registration owns dispatch on the sub-path, reducing seven separate
 * registrations to a single disposer.
 */

/** Output captured per update step, truncated so JSON responses stay small. */
const MAX_STEP_OUTPUT = 32_000

/** Upper bounds for the payload the two JSON write routes accept. */

const execFileAsync = promisify(execFile)

/**
 * pnpm 11 propagates its own workspace flags as `NPM_CONFIG_*` env vars
 * (chiefly `NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS`), which npm 11
 * warns about as an unknown env config. Strip the known offenders before
 * spawning any child so the noise never leaks into the plugin's captured
 * output. Only pnpm's own subprocesses need this var; dropping it at the
 * boundary does not disable the pnpm feature — pnpm still honors its
 * pnpm-workspace.yaml / .npmrc config sources inside the child.
 *
 * Also force git into non-interactive mode: our plugin subprocess has no
 * tty, so any credential prompt (git-credential-manager, ask-pass) hangs or
 * crashes. Setting `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=Never` makes
 * git fail fast with a readable "could not read Username" message when a
 * private repo needs auth that isn't already cached.
 */

/**
 * pnpm 11 propagates its own workspace flags as `NPM_CONFIG_*` env vars
 * (chiefly `NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS`), which npm 11
 * warns about as an unknown env config. Strip the known offenders before
 * spawning any child so the noise never leaks into the plugin's captured
 * output. Only pnpm's own subprocesses need this var; dropping it at the
 * boundary does not disable the pnpm feature — pnpm still honors its
 * pnpm-workspace.yaml / .npmrc config sources inside the child.
 *
 * Also force git into non-interactive mode: our plugin subprocess has no
 * tty, so any credential prompt (git-credential-manager, ask-pass) hangs or
 * crashes. Setting `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=Never` makes
 * git fail fast with a readable "could not read Username" message when a
 * private repo needs auth that isn't already cached.
 */
const NOISY_NPM_ENV_VARS: readonly string[] = [
  'NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS',
  'npm_config_manage_package_manager_versions',
]

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of NOISY_NPM_ENV_VARS) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GCM_INTERACTIVE = 'Never'
  return env
}

/**
 * Recognize git errors that come from "no cached credentials for a private
 * repo" and the OAuth 2.0 `invalid_client` family enterprise GitHub returns
 * when SSO / OIDC rejects the HTTP Basic auth git tried. These are the
 * exact strings git / GCM / the OAuth server emit. When one hits we
 * replace the raw output with an actionable message pointing at the two
 * viable workarounds (SSH with configured keys, or an SSO-authorized PAT).
 */

/** $DSH_HOME resolution, matching what the launcher and other bundles use. */
const DSH_HOME = process.env.DSH_HOME ?? join(os.homedir(), '.dsh')
/** dsh-skill-filesystem user-dsh root (rank 400). Written by the install route. */

/** Workbench-owned state directory (installed-skill registry, workbench.json). */
const WORKBENCH_STATE_DIR = join(DSH_HOME, 'whaletv-workbench')

/**
 * Resolve spawn options for this platform: npm/pnpm are .cmd shims on
 * Windows and must run through the shell; git.exe spawns directly.
 * @param command - bare command name (git / pnpm).
 * @returns the execFile options for one invocation.
 */
function spawnOptions(command: string): { shell: boolean } {
  const needsShell = process.platform === 'win32' && (command === 'pnpm' || command === 'npm')
  return { shell: needsShell }
}

/**
 * Run one command; returns merged trimmed output. Defaults cwd to this
 * plugin's package dir (where git operations for self-update live), but the
 * skill-import route overrides cwd so clones happen in the staging root.
 */

/**
 * Run one command; returns merged trimmed output. Defaults cwd to this
 * plugin's package dir (where git operations for self-update live), but the
 * skill-import route overrides cwd so clones happen in the staging root.
 */
async function run(command: string, args: string[], cwd: string = PACKAGE_DIR): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: sanitizedEnv(),
      ...spawnOptions(command),
    })
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim()
    const detail = failure.message ?? String(error)
    throw new Error(output === '' ? detail : `${output}\n${detail}`)
  }
}

/** git output, or undefined when the directory is not a git work tree. */

/** git output, or undefined when the directory is not a git work tree. */
async function git(args: string[]): Promise<string | undefined> {
  try {
    return await run('git', args)
  } catch {
    return undefined
  }
}

/** Trim one step's captured output to the response budget. */

/** Trim one step's captured output to the response budget. */
function truncate(output: string): string {
  if (output.length <= MAX_STEP_OUTPUT) return output
  return `${output.slice(0, MAX_STEP_OUTPUT)}\n… (已截断)`
}

/**
 * Read the entry config: `$DSH_HOME/whaletv-workbench/workbench.json` when
 * present, falling back to the legacy plugin-dir path once (with implicit
 * migration to the new location), then the shipped template. A broken file
 * renders as a single error group so the panel remains usable.
 */

/**
 * Collect a request body with a size cap. Resolves the parsed JSON; rejects
 * with a readable message on oversize / stream errors / malformed JSON.
 * @param req - the incoming request.
 * @param maxBytes - upper bound for this specific request.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      reject(new Error(message))
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        fail(`请求体过大（超过 ${maxBytes / 1024}KB）`)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法的 JSON'))
      }
    })
    req.on('error', () => { fail('读取请求体失败') })
  })
}

/**
 * Trim a string field: non-strings and blank strings collapse to undefined
 * (the field is dropped from the persisted item).
 */

/**
 * Trim a string field: non-strings and blank strings collapse to undefined
 * (the field is dropped from the persisted item).
 */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Validate and normalize a raw WorkbenchConfig payload.
 */

/** Read this package's version from its manifest. */
function readVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Assemble the GET /whaletv/workbench/state payload. */

/** Send one JSON response with a UTF-8 content type. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-cache',
  })
  res.end(payload)
}

/**
 * Run the self-update pipeline and record the attempt into the rolling
 * history (roadmap P1-9). Never throws: every failure returns an
 * actionable { ok: false, error } result. History writes are best-effort —
 * a broken updates.json must never turn a good update into a panel error.
 */

export {
  CLIENT_ID, PACKAGE_DIR, MAX_STEP_OUTPUT, execFileAsync, sanitizedEnv, run, git,
  truncate, readJsonBody, cleanString, readVersion, sendJson, DSH_HOME, WORKBENCH_STATE_DIR,
}
