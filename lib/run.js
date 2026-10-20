/**
 * Child-process runner shared by every LaTeX tool.
 *
 * Every process this plugin starts is captured as **bytes**, never as text.
 * `child_process` with `encoding: 'utf8'` would decode the stream the same way
 * for both stdout and stderr, and the measurement in `lib/decode.js` shows
 * those two streams carry different encodings on this machine (latexmk writes
 * UTF-8 to stdout and GBK to stderr). Passing `text: true` — what the official
 * plugin does through `subprocess.run(text=True)` — is precisely its F2
 * (`UnicodeDecodeError: 'utf-8' codec can't decode byte 0xd1`).
 *
 * Two Windows-specific behaviours are handled here rather than in callers:
 *
 *   - **Tree kill.** `latexmk` is a Perl wrapper that starts the real engine as
 *     a grandchild; killing `latexmk` alone leaves xelatex running and holding
 *     the output pipe. The deadline path therefore kills the tree first.
 *   - **No visible console.** The desktop app is a GUI process, so a
 *     console-subsystem child would otherwise allocate and flash a black
 *     window — including `taskkill`. Every spawn sets `windowsHide`.
 *
 * @module @local/dsh-latex-tool/lib/run
 */

import { spawn } from 'node:child_process'
import { decodeOutput, looksDamaged, stripAnsi } from './decode.js'

/** Default deadline for a toolchain probe (a version query). */
export const PROBE_TIMEOUT_MS = 30_000
/** Default deadline for one latexmk run. */
export const COMPILE_TIMEOUT_MS = 180_000
/** Hard ceiling for a caller-supplied deadline. */
export const MAX_TIMEOUT_MS = 900_000
/** Per-stream capture cap. A failed xelatex run is verbose; 1 MB is ample. */
const MAX_OUTPUT_BYTES = 1024 * 1024
/**
 * After killing a tree, how long to keep waiting for the pipes to close.
 *
 * The surviving grandchild can hold the pipe open for as long as the original
 * command would have run, so waiting for `close` would make every timeout
 * return late by minutes.
 */
const POST_KILL_GRACE_MS = 400

/**
 * Kill a process and its descendants on Windows (and the direct child
 * elsewhere).
 *
 * @param child - the spawned child process.
 * @returns a promise that settles once the kill attempt has been made.
 */
async function killTree(child) {
  if (child === undefined || child.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.on('error', finish)
        killer.on('close', finish)
        setTimeout(finish, 2000)
      } catch {
        finish()
      }
    })
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * Collect one piped stream into a buffer, with a byte cap.
 * @param stream - the child stream to drain.
 * @returns a reader producing the captured bytes once the stream has ended.
 */
function collector(stream) {
  const chunks = []
  let total = 0
  let truncated = false
  stream.on('data', (chunk) => {
    if (total >= MAX_OUTPUT_BYTES) {
      truncated = true
      return
    }
    const room = MAX_OUTPUT_BYTES - total
    if (chunk.length > room) {
      chunks.push(chunk.subarray(0, room))
      total = MAX_OUTPUT_BYTES
      truncated = true
      return
    }
    chunks.push(chunk)
    total += chunk.length
  })
  return () => ({ buffer: Buffer.concat(chunks), truncated })
}

/**
 * Run one executable to completion.
 *
 * @param options - executable, argv, cwd, deadline, environment and abort signal.
 * @returns exit code, decoded streams, and how the encoding was decided.
 */
export async function runProcess(options) {
  const {
    executable,
    argv = [],
    cwd = undefined,
    timeoutMs = PROBE_TIMEOUT_MS,
    env = undefined,
    signal = undefined,
    stdin = null,
  } = options

  if (typeof executable !== 'string' || executable.length === 0) {
    throw new Error('latex-tool: runProcess needs an executable path')
  }
  const deadline = Math.min(
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROBE_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  )

  let child
  try {
    child = spawn(executable, argv, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: env ?? process.env,
    })
  } catch (error) {
    const hint =
      error?.code === 'ENOENT'
        ? ` The executable was not found at "${executable}".`
        : ''
    throw new Error(`latex-tool: could not start "${executable}": ${error?.message ?? String(error)}.${hint}`)
  }

  const readStdout = collector(child.stdout)
  const readStderr = collector(child.stderr)

  let timedOut = false
  let aborted = false
  let killPromise = null

  let settle
  const settled = new Promise((resolve) => {
    settle = resolve
  })
  child.on('error', (error) => settle({ spawnError: error }))
  child.on('close', (exitCode, exitSignal) => settle({ exitCode, signal: exitSignal }))

  const terminate = (reason) => {
    if (reason === 'timeout') timedOut = true
    if (reason === 'abort') aborted = true
    if (killPromise !== null) return
    killPromise = killTree(child).then(() => {
      setTimeout(() => settle({ exitCode: null, signal: 'SIGKILL' }), POST_KILL_GRACE_MS)
    })
  }

  const timer = setTimeout(() => terminate('timeout'), deadline)
  const onAbort = () => terminate('abort')
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  // Nothing driven here needs input: closing stdin immediately turns an
  // accidental prompt into a fast EOF instead of a deadline-length hang.
  if (typeof stdin === 'string' && stdin.length > 0) child.stdin.end(stdin)
  else child.stdin.end()

  const outcome = await settled
  clearTimeout(timer)
  signal?.removeEventListener?.('abort', onAbort)

  if (outcome.spawnError) {
    const code = outcome.spawnError.code
    const hint =
      code === 'ENOENT'
        ? ` The executable was not found at "${executable}".`
        : ''
    throw new Error(`latex-tool: failed to run "${executable}": ${outcome.spawnError.message}.${hint}`)
  }

  const stdout = readStdout()
  const stderr = readStderr()
  const decodedStdout = decodeOutput(stdout.buffer)
  const decodedStderr = decodeOutput(stderr.buffer)

  return {
    exitCode: outcome.exitCode ?? null,
    signal: outcome.signal ?? null,
    timedOut,
    aborted,
    truncated: stdout.truncated || stderr.truncated,
    stdout: stripAnsi(decodedStdout.text),
    stderr: stripAnsi(decodedStderr.text),
    encoding: { stdout: decodedStdout.encoding, stderr: decodedStderr.encoding },
    damaged: looksDamaged(decodedStdout.text) || looksDamaged(decodedStderr.text),
    argv,
  }
}

/**
 * Run an executable and report only the first line that matches a pattern.
 *
 * Version probes are where this matters: TeX Live's `latexmk` is a Perl
 * wrapper whose stderr carries a `perl: warning: Setting locale failed` block,
 * and reading the first non-empty line (the official plugin's F4) returns that
 * warning instead of the version.
 *
 * @param options - as {@link runProcess}, plus `pattern`.
 * @returns the matched line and the full result.
 */
export async function runVersionProbe(options) {
  const { pattern } = options
  const result = await runProcess(options)
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim())
  const match = lines.find((line) => line.length > 0 && pattern.test(line))
  return { line: match ?? '', ...result }
}
