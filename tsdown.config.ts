/**
 * whaletv-workbench build faces, inlined from the harness's
 * packages/client/tsdown.client.ts preset so this project stays independent
 * of the harness checkout:
 *
 * - lib face (Node): bundles src/index.ts (the Host half) as ESM into
 *   lib/index.js, externalizing every @deepseek-ai/* and node:* import —
 *   those resolve at runtime from the dsh profile's node_modules.
 * - client face (Browser): bundles src/client/index.ts into lib/client.js as
 *   a closure-factory artifact: window.__ModuleLoader__.load({id, factory}),
 *   externals resolved through the loader module table (react, cordis,
 *   dsh-client-* platform modules), CSS Modules inlined by lightningcss.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Plugin id — must match the package name and the cordis.patch.yml row name. */
const ID = 'whaletv-workbench'

/**
 * The harness's browser platform seed modules (packages/client/web/src/
 * platform.ts PLATFORM_MODULES) — the frozen module table a client bundle
 * may require. dsh 0.1.2 shrank this surface hard: dsh-client-runtime,
 * dsh-client-web-react, and dsh-client-schema-form were removed upstream,
 * and the workbench now needs only react (jsx runtime), dsh-client-store,
 * and dsh-client-ui-primitives at materialization. Keep in sync when
 * upgrading dsh.
 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** CSS Modules: compile *.module.css with lightningcss and inject a <style data-plugin> tag. */
function cssModulesPlugin() {
  return {
    name: 'whaletv-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolve(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile: (id: string) => void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/** Host-half (Node) library: the dsh Loader imports this as the plugin entry. */
const libConfig: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  external: [/^@deepseek-ai\//, /^node:/],
}

/** Browser client bundle, served by dsh at /plugins/whaletv-workbench/client.js. */
const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // Everything not in the loader module table inlines (clsx and friends).
  deps: {
    alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id as typeof CLIENT_EXTERNALS[number]) ? undefined : true),
  },
  plugins: [cssModulesPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [libConfig, clientConfig]
