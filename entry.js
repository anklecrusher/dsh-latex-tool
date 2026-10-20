/**
 * Cache-busting entry point for the LaTeX tool plugin.
 *
 * Why this file exists
 * --------------------
 * Node caches ES modules by resolved URL, permanently, for the lifetime of the
 * process. Cordis re-runs a plugin's `apply` on reload, but it cannot make the
 * runtime re-import an already-imported file: the cached module is handed back
 * every time. This bundle's code lives outside the profile directory and is
 * therefore not watched by the profile's HMR roots, so a plain reload cannot
 * pick up an edit either.
 *
 * This entry therefore imports the implementation through a unique URL on each
 * activation (`?t=<timestamp>`), which forces a genuinely fresh module. Editing
 * `index.js` or `lib/*.js` and toggling the plugin then takes effect
 * immediately, with no harness restart.
 *
 * The trade-off is deliberate and small: each activation materializes one more
 * module instance, on an explicit human action (a plugin toggle) rather than
 * per request.
 *
 * `inject` must stay a static export: the DI declaration has to be readable
 * without executing the implementation module.
 *
 * @module @local/dsh-latex-tool/entry
 */

/**
 * Service dependency: this plugin contributes tools, and optionally a skill
 * provider and a panel route.
 *
 * Only `tools` is declared here. `skills` and `webServer` are attached with
 * `ctx.inject` inside the implementation instead, because declaring them at
 * this level would make the whole plugin fail to activate in a composition that
 * has no skill registry (a bare CLI run) — and the three tools are useful on
 * their own.
 */
export const inject = ['tools']

/**
 * Load the implementation fresh and delegate activation to it.
 * @param ctx - the plugin context carrying the `tools` and `skills` services.
 * @param config - optional plugin config (see cordis.patch.yml).
 * @returns the implementation's own activation result.
 */
export async function apply(ctx, config) {
  const url = new URL(`./index.js?t=${Date.now()}`, import.meta.url)
  const implementation = await import(url.href)
  return implementation.apply(ctx, config)
}
