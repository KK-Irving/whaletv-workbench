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
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Plugin id — must match the package name and the cordis.patch.yml row name. */
const ID = 'whaletv-workbench'

/** This config's directory = the package root. */
const ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * Reproducible build input for lightningcss: a project-root-relative POSIX
 * path instead of the absolute one. lightningcss mixes the filename into every
 * CSS-module class hash, so an absolute path made the emitted class names (and
 * therefore lib/client.js) depend on where the checkout happens to live —
 * different machines produced different bundles from identical sources, and a
 * "committed lib/ == fresh build" gate could never pass.
 */
function stableCssId(file: string): string {
  const rel = relative(ROOT, file)
  const chosen = rel === '' || rel.startsWith('..') ? basename(file) : rel
  return chosen.split('\\').join('/')
}

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

/**
 * Virtual module id for one CSS Module: the project-root-relative POSIX path.
 * The previous absolute-path form leaked the checkout location into
 * rolldown's `//#region` comments, so two machines (or two directories) built
 * different bundles from the same sources.
 */
function cssVirtualId(file: string): string {
  return `${CSS_VIRTUAL_PREFIX}${stableCssId(file)}${CSS_VIRTUAL_SUFFIX}`
}

/** CSS Modules: compile *.module.css with lightningcss and inject a <style data-plugin> tag. */
function cssModulesPlugin() {
  return {
    name: 'whaletv-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolve(dirname(importer), source) : source
      return cssVirtualId(abs)
    },
    async load(this: { addWatchFile: (id: string) => void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX) || !virtualId.endsWith(CSS_VIRTUAL_SUFFIX)) return null
      // The id carries the root-relative path; resolve it back for reading.
      const relId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const fileId = resolve(ROOT, relId)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: relId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      // lightningcss hands its export map back in randomized hash order, so
      // two builds of identical sources emitted the keys in different orders
      // and every rebuild rewrote lib/client.js. Sorting makes the bundle
      // byte-reproducible (and the lib/ drift gate meaningful).
      const exportsMap = cssExports ?? {}
      for (const local of Object.keys(exportsMap).sort()) {
        classMap[local] = exportsMap[local].name
      }
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
