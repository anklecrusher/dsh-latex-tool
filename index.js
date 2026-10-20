/**
 * LaTeX compile / verify / doctor for the DeepSeek Harness.
 *
 * This module owns four things:
 *   1. the tool registrations (delegated to `lib/tools.js`),
 *   2. the bundled skill provider (delegated to `lib/skill.js`),
 *   3. the settings panel's same-origin JSON route,
 *   4. nothing else.
 *
 * @module @local/dsh-latex-tool
 */

import { normalizeConfig, readState, resolveSettings, stateFilePath } from './lib/config.js'
import { createService } from './lib/service.js'
import { registerSkill } from './lib/skill.js'
import { createTools } from './lib/tools.js'

/** Same-origin JSON route the settings panel reads through. */
const ROUTE = '/plugins/dsh-latex-tool/rpc'
/** Request-body cap; every payload here is tiny. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Reject cross-origin callers.
 *
 * The panel is served from the same origin as the harness, so a request that
 * carries a different `Origin` is not from our UI.
 *
 * @param req - the Node request.
 * @returns true when the request is same-origin or carries no Origin.
 */
function sameOrigin(req) {
  const { origin, host } = req.headers
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`) {
    return false
  }
  return true
}

/**
 * Write a JSON response.
 * @param res - the Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serialisable body.
 */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read and parse a JSON request body within the size cap.
 * @param req - the Node request.
 * @returns the parsed body.
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length === 0 ? {} : JSON.parse(text)
}

/**
 * Plugin entry point.
 *
 * @param ctx - the plugin context (requires `tools`; `skills` is required for
 *   the bundled skill and is checked rather than assumed).
 * @param config - raw config from the bundle patch.
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const patch = normalizeConfig(config, logger)
  const service = createService(patch, logger)

  // `ctx` is passed through because relative paths must be resolved against the
  // session working directory, which is a service (`workingDirectory.ensure`),
  // not a field on the tool execution context. See resolveSessionCwd.
  for (const tool of createTools(service, { logger, ctx })) {
    ctx.tools.register(tool)
  }

  // The skill provider needs `skills`. Declaring the dependency this way keeps
  // the plugin loadable in a composition that has no skill registry (a bare CLI
  // run) instead of failing to activate entirely.
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => {
      const registered = registerSkill(skillCtx, logger)
      return () => {
        registered.dispose?.()
        logger?.info?.('latex: skill provider disposed')
      }
    }, 'dsh-latex-tool: bundled skill')
  })

  // The Web panel is optional: a profile without a web server still gets every
  // tool. `ctx.inject` defers registration until the service exists, which is
  // what makes the plugin activate in both deployments.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          if (!sameOrigin(req)) return json(res, 403, { error: 'origin-rejected' })
          if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            return json(res, 400, { error: 'invalid-request', detail: error.message })
          }

          const action = body?.action
          try {
            switch (action) {
              case 'doctor': {
                const report = await service.doctor({ smoke: false })
                return json(res, 200, { ok: true, doctor: report })
              }
              case 'smoke': {
                const report = await service.doctor({ smoke: true })
                return json(res, 200, { ok: true, smoke: report.smoke })
              }
              case 'config':
                return json(res, 200, { ok: true, config: await service.settingsPayload() })
              case 'set': {
                const updated = await service.updateSettings({
                  defaultEngine: body?.defaultEngine,
                  respectLatexmkrc: body?.respectLatexmkrc,
                })
                return json(res, 200, { ok: true, config: updated.config, pinned: updated.pinned })
              }
              case 'history': {
                const records = service.history()
                return json(res, 200, {
                  ok: true,
                  history: records.map((entry) => ({ ...entry, pdfOnDisk: service.statPdf(entry.pdfPath) })),
                })
              }
              case 'state':
                return json(res, 200, { ok: true, state: readState(stateFilePath()), config: await service.settingsPayload() })
              default:
                return json(res, 400, { error: 'unknown-action', action })
            }
          } catch (error) {
            logger?.warn?.(`latex: panel action "${action}" failed: ${error.message}`)
            return json(res, 500, { error: 'action-failed', action, detail: error.message })
          }
        },
      }),
      'dsh-latex-tool: panel rpc route',
    )
  })

  const effective = resolveSettings(patch, readState(stateFilePath()))
  logger?.info?.(
    `latex: tools registered (defaultEngine ${effective.settings.defaultEngine} from ${effective.sources.defaultEngine}, `
    + `norc ${effective.settings.respectLatexmkrc !== true})`,
  )
}

/** Package identity, for diagnostics. */
export const name = 'dsh-latex-tool'
