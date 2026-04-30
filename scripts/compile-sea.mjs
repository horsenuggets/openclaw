#!/usr/bin/env node
/**
 * compile-sea.mjs — Compile OpenClaw using Node.js SEA (Single Executable Application).
 *
 * Alternative to compile.mjs (which uses Bun compile). Downloads the target platform's
 * Node.js binary from nodejs.org and injects the JS bundle as a SEA blob. Enables true
 * cross-compilation from a single Linux host — no per-platform Bun download required,
 * which eliminates the windows-arm64 cross-compilation flakiness.
 *
 * The prep pipeline (tsdown build, wrapper generation, extension embedding) still requires
 * Bun locally (same as compile.mjs). The difference is that the final cross-compilation
 * step downloads reliable Node.js binaries from nodejs.org instead of Bun's cross-compile
 * targets. Three binaries are produced: openclaw, discord-router, health-monitor.
 *
 * Usage:
 *   node scripts/compile-sea.mjs                        # Build all platforms
 *   node scripts/compile-sea.mjs --target linux-x64     # Build one platform
 *   node scripts/compile-sea.mjs --skip-build           # Skip tsdown + bundle steps
 *
 * Requirements: Node.js 22+, Bun (for prep pipeline), pnpm
 * Node version: NODE_SEA_VERSION env var (default: current process version)
 */

import { execSync } from 'child_process'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import https from 'https'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// Pin to a specific Node.js version for reproducible binaries.
// Override with NODE_SEA_VERSION=22.x.x to use a different version.
const NODE_VERSION = process.env.NODE_SEA_VERSION ?? process.versions.node

// Cache directory for downloaded Node.js binaries.
const CACHE_DIR = join(ROOT, '.sea-cache')

// SEA sentinel fuse required by the postject injection API.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const TARGETS = [
  {
    name: 'linux-x64',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz`,
    type: 'tgz',
    binaryPath: `node-v${NODE_VERSION}-linux-x64/bin/node`,
    ext: '',
  },
  {
    name: 'linux-arm64',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    type: 'tgz',
    binaryPath: `node-v${NODE_VERSION}-linux-arm64/bin/node`,
    ext: '',
  },
  {
    name: 'macos-arm64',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    type: 'tgz',
    binaryPath: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
    ext: '',
    macho: true,
  },
  {
    name: 'macos-x64',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    type: 'tgz',
    binaryPath: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
    ext: '',
    macho: true,
  },
  {
    name: 'windows-x64',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`,
    type: 'exe',
    ext: '.exe',
  },
  {
    name: 'windows-arm64',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/win-arm64/node.exe`,
    type: 'exe',
    ext: '.exe',
  },
]

// Native addons and platform-specific packages that cannot be embedded.
const EXTERNAL_MODULES = [
  'sharp',
  '@img/sharp-*',
  'node-llama-cpp',
  '@node-llama-cpp/*',
  'playwright',
  'electron',
  '@xenova/*',
  'onnxruntime-node',
]

// Extensions that fail to load as embedded (legacy export patterns, import issues).
const EMBEDDED_SKIP = new Set(['lobster', 'open-prose'])

// --- Argument parsing ---

const args = process.argv.slice(2)
const targetArg = args.indexOf('--target')
const selectedTarget = targetArg !== -1 ? args[targetArg + 1] : undefined
const skipBuild = args.includes('--skip-build')

if (selectedTarget && !TARGETS.find((t) => t.name === selectedTarget)) {
  console.error(`Unknown target: ${selectedTarget}`)
  console.error(`Valid targets: ${TARGETS.map((t) => t.name).join(', ')}`)
  process.exit(1)
}

const targets = selectedTarget ? TARGETS.filter((t) => t.name === selectedTarget) : TARGETS

// --- Helper: download with redirect following and progress output ---

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    const request = (u) => {
      https
        .get(u, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            file.close()
            return request(res.headers.location)
          }
          if (res.statusCode !== 200) {
            file.close()
            try { unlinkSync(dest) } catch {}
            return reject(new Error(`HTTP ${res.statusCode} from ${u}`))
          }
          const total = parseInt(res.headers['content-length'] ?? '0', 10)
          let received = 0
          res.on('data', (chunk) => {
            received += chunk.length
            if (total) {
              const pct = ((received / total) * 100).toFixed(0).padStart(3)
              process.stdout.write(`\r    ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)    `)
            }
          })
          res.pipe(file)
          file.on('finish', () => {
            process.stdout.write('\n')
            file.close(resolve)
          })
        })
        .on('error', (err) => {
          file.close()
          try { unlinkSync(dest) } catch {}
          reject(err)
        })
    }
    request(url)
  })
}

// --- Helper: get (and cache) the Node.js binary for a target ---

async function getNodeBinary(target) {
  mkdirSync(CACHE_DIR, { recursive: true })

  const cacheKey = `node-${NODE_VERSION}-${target.name}${target.ext}`
  const cachedBinary = join(CACHE_DIR, cacheKey)

  if (existsSync(cachedBinary)) {
    console.log(`    Using cached: ${cacheKey}`)
    return cachedBinary
  }

  console.log(`    Downloading Node.js ${NODE_VERSION} for ${target.name}...`)
  console.log(`    ${target.url}`)

  if (target.type === 'exe') {
    // Windows: direct .exe download, no extraction needed.
    await download(target.url, cachedBinary)
  } else {
    // Linux/macOS: tar.gz, extract just the node binary.
    const archivePath = join(CACHE_DIR, `node-${NODE_VERSION}-${target.name}.tar.gz`)
    if (!existsSync(archivePath)) {
      await download(target.url, archivePath)
    }
    const extractDir = join(CACHE_DIR, `extract-${target.name}`)
    mkdirSync(extractDir, { recursive: true })
    execSync(`tar xzf "${archivePath}" -C "${extractDir}" "${target.binaryPath}"`, { stdio: 'pipe' })
    copyFileSync(join(extractDir, target.binaryPath), cachedBinary)
    chmodSync(cachedBinary, 0o755)
    execSync(`rm -rf "${extractDir}"`, { stdio: 'pipe' })
  }

  return cachedBinary
}

// --- Helper: remove macOS codesignature before SEA injection ---

function removeMacOSSignature(binaryPath) {
  if (process.platform === 'darwin') {
    try {
      execSync(`codesign --remove-signature "${binaryPath}"`, { stdio: 'pipe' })
    } catch {
      // Not signed, or already unsigned — continue.
    }
  } else {
    // Cross-compiling on Linux: try rcodesign (cargo install apple-codesign).
    try {
      execSync(`rcodesign sign "${binaryPath}"`, { stdio: 'pipe' })
    } catch {
      console.warn(`    Note: rcodesign not found — macOS binary will be unsigned.`)
      console.warn(`    Users may need: xattr -d com.apple.quarantine ./openclaw-macos-arm64`)
    }
  }
}

// --- Helper: re-sign macOS binary after SEA injection ---

function resignMacOS(binaryPath) {
  if (process.platform === 'darwin') {
    try {
      execSync(`codesign --sign - "${binaryPath}"`, { stdio: 'pipe' })
    } catch (e) {
      console.warn(`    Warning: could not re-sign macOS binary: ${e.message}`)
    }
  }
  // On Linux: binary stays unsigned (acceptable for CI artifacts).
}

// ============================================================
// Main
// ============================================================

console.log(`Node SEA compile — Node.js v${NODE_VERSION}`)
console.log(`Targets: ${targets.map((t) => t.name).join(', ')}\n`)

// -------------------------------------------------------
// Phase 1: Prep pipeline (mirrors compile.mjs steps 1–7)
// -------------------------------------------------------

if (!skipBuild) {
  // Step 1: Build with tsdown.
  console.log('Building with tsdown (pnpm build)...')
  execSync('pnpm build', { stdio: 'inherit', cwd: ROOT })
  console.log()

  if (!existsSync(join(ROOT, 'dist/entry.js'))) {
    console.error('Build failed: dist/entry.js not found')
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

  // Step 2: Replace __OPENCLAW_VERSION__ in all dist chunks.
  {
    function walkJsFiles(dir) {
      const results = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) results.push(...walkJsFiles(full))
        else if (entry.name.endsWith('.js')) results.push(full)
      }
      return results
    }
    let replaced = 0
    for (const filePath of walkJsFiles(join(ROOT, 'dist'))) {
      let content = readFileSync(filePath, 'utf-8')
      if (content.includes('__OPENCLAW_VERSION__')) {
        content = content.replace(/__OPENCLAW_VERSION__/g, JSON.stringify(pkg.version))
        writeFileSync(filePath, content)
        replaced++
      }
    }
    console.log(`Replaced __OPENCLAW_VERSION__ in ${replaced} chunk(s)`)
  }

  // Step 3: Generate binary-setup-env.js.
  const setupEntry = join(ROOT, 'dist/binary-setup-env.js')
  writeFileSync(
    setupEntry,
    [
      `import { writeFileSync, mkdirSync, existsSync } from "node:fs";`,
      `import { tmpdir } from "node:os";`,
      `import { join } from "node:path";`,
      ``,
      `const pkgDir = join(tmpdir(), "openclaw-runtime");`,
      `try { mkdirSync(pkgDir, { recursive: true }); } catch {}`,
      `const pkgPath = join(pkgDir, "package.json");`,
      `if (!existsSync(pkgPath)) {`,
      `  writeFileSync(pkgPath, ${JSON.stringify(JSON.stringify({ name: pkg.name, version: pkg.version }))});`,
      `}`,
      `process.env.PI_PACKAGE_DIR = pkgDir;`,
    ].join('\n') + '\n',
  )

  // Step 4: Generate binary-entry.js.
  const wrapperEntry = join(ROOT, 'dist/binary-entry.js')
  writeFileSync(
    wrapperEntry,
    [
      `import "./binary-setup-env.js";`,
      `import * as pluginSdk from "./plugin-sdk/index.js";`,
      `globalThis.__OPENCLAW_PLUGIN_SDK__ = pluginSdk;`,
      ``,
      `// Import embedded plugins (generated at build time, may not exist yet)`,
      `try { await import("./binary-embedded-plugins.js"); } catch (e) { console.error("[embedded-plugins] failed to load:", e?.message ?? e); }`,
      ``,
      `await import("./entry.js");`,
    ].join('\n') + '\n',
  )
  console.log('Generated dist/binary-entry.js')

  // Step 5: Create chromium-bidi shims for playwright-core.
  {
    const pwCoreDirs = readdirSync(join(ROOT, 'node_modules/.pnpm'))
      .filter((d) => d.startsWith('playwright-core@'))
      .map((d) => `node_modules/.pnpm/${d}/node_modules`)
    const pwDir = pwCoreDirs[0]
    if (!pwDir) {
      console.log('playwright-core not found, skipping chromium-bidi shims')
    } else {
      const shimPaths = [
        `${pwDir}/chromium-bidi/package.json`,
        `${pwDir}/chromium-bidi/index.js`,
        `${pwDir}/chromium-bidi/lib/cjs/bidiMapper/BidiMapper.js`,
        `${pwDir}/chromium-bidi/lib/cjs/cdp/CdpConnection.js`,
      ]
      for (const p of shimPaths) {
        const dir = p.substring(0, p.lastIndexOf('/'))
        if (!existsSync(join(ROOT, dir))) {
          execSync(`mkdir -p "${join(ROOT, dir)}"`, { stdio: 'pipe' })
        }
      }
      if (!existsSync(join(ROOT, `${pwDir}/chromium-bidi/index.js`))) {
        writeFileSync(
          join(ROOT, `${pwDir}/chromium-bidi/package.json`),
          '{"name":"chromium-bidi","version":"0.0.0-shim","main":"index.js"}\n',
        )
        writeFileSync(join(ROOT, `${pwDir}/chromium-bidi/index.js`), 'module.exports = {};\n')
        writeFileSync(
          join(ROOT, `${pwDir}/chromium-bidi/lib/cjs/bidiMapper/BidiMapper.js`),
          'module.exports = {};\n',
        )
        writeFileSync(
          join(ROOT, `${pwDir}/chromium-bidi/lib/cjs/cdp/CdpConnection.js`),
          'module.exports = {};\n',
        )
        console.log('Created chromium-bidi shims')
      }
    }
  }

  // Step 6: Copy and pre-compile extensions.
  if (existsSync(join(ROOT, 'extensions'))) {
    console.log('\nCopying extensions...')
    if (existsSync(join(ROOT, 'dist/extensions'))) {
      const tmpDir = `${process.env.TMPDIR ?? '/tmp'}/openclaw-ext-cleanup-${Date.now()}`
      execSync(`mv "${join(ROOT, 'dist/extensions')}" "${tmpDir}" && rm -rf "${tmpDir}" &`, {
        stdio: 'inherit',
        shell: true,
      })
    }
    execSync('rsync -a --exclude="node_modules" --exclude=".builds" extensions/ dist/extensions/', {
      stdio: 'inherit',
      cwd: ROOT,
    })
    console.log('  Pre-compiling extensions...')
    let compiledCount = 0
    let failedCount = 0
    for (const extDir of readdirSync(join(ROOT, 'dist/extensions'))) {
      const extPath = join(ROOT, `dist/extensions/${extDir}`)
      const indexTs = join(extPath, 'index.ts')
      if (!existsSync(indexTs)) continue
      try {
        execSync(
          `bun build "${indexTs}" --outdir "${extPath}" --target node --external openclaw --external "openclaw/*"`,
          { stdio: 'pipe', cwd: ROOT },
        )
        const pkgPath = join(extPath, 'package.json')
        if (existsSync(pkgPath)) {
          let content = readFileSync(pkgPath, 'utf-8')
          content = content.replace(/\.\/index\.ts/g, './index.js')
          content = content.replace(/\.\/src\//g, './src/')
          writeFileSync(pkgPath, content)
        }
        compiledCount++
      } catch {
        console.log(`    Warning: failed to pre-compile ${extDir}`)
        failedCount++
      }
    }
    console.log(`  Extensions: ${compiledCount} compiled, ${failedCount} failed`)

    // Create openclaw/plugin-sdk shim for extensions.
    const shimPkgDir = join(ROOT, 'dist/extensions/node_modules/openclaw')
    const shimSdkDir = join(shimPkgDir, 'plugin-sdk')
    execSync(`mkdir -p "${shimSdkDir}"`, { stdio: 'pipe' })
    writeFileSync(
      join(shimPkgDir, 'package.json'),
      '{"name":"openclaw","exports":{"./plugin-sdk":"./plugin-sdk/index.js"}}\n',
    )
    writeFileSync(
      join(shimSdkDir, 'index.js'),
      'module.exports = globalThis.__OPENCLAW_PLUGIN_SDK__;\n',
    )
    console.log('  Created openclaw/plugin-sdk shim in extensions/node_modules/')

    // Step 7: Generate binary-embedded-plugins.js.
    const embeddedImports = []
    const embeddedRegistrations = []
    for (const extDir of readdirSync(join(ROOT, 'dist/extensions')).toSorted()) {
      const indexJs = join(ROOT, `dist/extensions/${extDir}/index.js`)
      if (!existsSync(indexJs) || extDir === 'node_modules' || EMBEDDED_SKIP.has(extDir)) {
        continue
      }
      const varName = `ext_${extDir.replace(/[^a-zA-Z0-9]/g, '_')}`
      embeddedImports.push(`import ${varName} from "./extensions/${extDir}/index.js";`)
      embeddedRegistrations.push(`  ["${extDir}", ${varName}],`)
    }
    const embeddedEntry = join(ROOT, 'dist/binary-embedded-plugins.js')
    writeFileSync(
      embeddedEntry,
      [
        `// Auto-generated: statically import all extensions for binary embedding.`,
        ...embeddedImports,
        ``,
        `globalThis.__OPENCLAW_EMBEDDED_PLUGINS__ = new Map([`,
        ...embeddedRegistrations,
        `]);`,
        ``,
      ].join('\n'),
    )
    console.log(
      `  Generated dist/binary-embedded-plugins.js (${embeddedRegistrations.length} extensions)`,
    )
  }

  // Step 8: Copy workspace templates.
  if (existsSync(join(ROOT, 'docs/reference/templates'))) {
    console.log('\nCopying workspace templates...')
    execSync('mkdir -p dist/docs/reference && cp -r docs/reference/templates dist/docs/reference/', {
      stdio: 'inherit',
      cwd: ROOT,
    })
    console.log('  Copied docs/reference/templates/')
  }

  console.log()

  // Step 9: Bundle each binary entry to CJS using Bun.
  // Unlike `bun build --compile`, this uses the LOCAL Bun to bundle (no cross-compilation
  // binary download). The resulting CJS files are then SEA-injected into Node.js binaries.
  const externals = EXTERNAL_MODULES.map((m) => `--external ${m}`).join(' ')

  console.log('Bundling openclaw to CJS...')
  execSync(
    `bun build dist/binary-entry.js --format=cjs ${externals} --outfile dist/openclaw-bundle.cjs`,
    { stdio: 'inherit', cwd: ROOT },
  )

  console.log('Bundling discord-router to CJS...')
  execSync(
    `bun build src/discord-router/entry.ts --format=cjs --outfile dist/discord-router-bundle.cjs`,
    { stdio: 'inherit', cwd: ROOT },
  )

  console.log('Bundling health-monitor to CJS...')
  execSync(
    `bun build discord-health-monitor/entry.ts --format=cjs --outfile dist/health-monitor-bundle.cjs`,
    { stdio: 'inherit', cwd: ROOT },
  )

  console.log()
}

// Verify bundles exist.
for (const name of ['openclaw-bundle', 'discord-router-bundle', 'health-monitor-bundle']) {
  if (!existsSync(join(ROOT, `dist/${name}.cjs`))) {
    console.error(`Bundle not found: dist/${name}.cjs (run without --skip-build or re-run prep)`)
    process.exit(1)
  }
}

// Step 10: Generate SEA blobs for each binary (platform-independent; generated once).
console.log('Generating SEA blobs...')

const BINARIES = [
  { name: 'openclaw', bundle: 'dist/openclaw-bundle.cjs', blob: 'dist/openclaw-sea.blob' },
  {
    name: 'discord-router',
    bundle: 'dist/discord-router-bundle.cjs',
    blob: 'dist/discord-router-sea.blob',
  },
  {
    name: 'health-monitor',
    bundle: 'dist/health-monitor-bundle.cjs',
    blob: 'dist/health-monitor-sea.blob',
  },
]

for (const bin of BINARIES) {
  console.log(`  ${bin.name}...`)
  const seaConfig = {
    main: bin.bundle,
    output: bin.blob,
    disableExperimentalSEAWarning: true,
  }
  const seaConfigPath = join(ROOT, `sea-config-${bin.name}.json`)
  writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2))
  execSync(`node --experimental-sea-config "${seaConfigPath}"`, { stdio: 'inherit', cwd: ROOT })
  unlinkSync(seaConfigPath)

  if (!existsSync(join(ROOT, bin.blob))) {
    console.error(`SEA blob generation failed: ${bin.blob} not found`)
    process.exit(1)
  }
  const blobSize = statSync(join(ROOT, bin.blob)).size
  console.log(`  ${bin.blob}: ${(blobSize / 1024 / 1024).toFixed(1)} MB`)
}

console.log()

// Step 11: Inject blobs into each target's Node.js binary.
console.log(`Injecting into ${targets.length} target(s)...`)

for (const target of targets) {
  console.log(`\n  ${target.name}`)

  try {
    const nodeBinary = await getNodeBinary(target)

    for (const bin of BINARIES) {
      const outfile = join(ROOT, `dist/${bin.name}-${target.name}${target.ext}`)
      console.log(`    -> dist/${bin.name}-${target.name}${target.ext}`)

      // Copy Node binary to output path (postject modifies in place).
      copyFileSync(nodeBinary, outfile)
      if (!target.ext) chmodSync(outfile, 0o755)

      // macOS: remove existing codesignature before injection.
      if (target.macho) removeMacOSSignature(outfile)

      // Inject the SEA blob.
      const machoFlag = target.macho ? '--macho-segment-name NODE_SEA' : ''
      execSync(
        `npx --yes postject "${outfile}" NODE_SEA_BLOB "${join(ROOT, bin.blob)}" --sentinel-fuse ${SEA_FUSE} ${machoFlag}`.trim(),
        { stdio: 'inherit', cwd: ROOT },
      )

      // macOS: re-sign with ad-hoc signature after injection.
      if (target.macho) resignMacOS(outfile)

      const size = statSync(outfile).size
      console.log(`    OK: ${(size / 1024 / 1024).toFixed(1)} MB`)
    }
  } catch (err) {
    console.error(`  Failed: ${err.message}`)
    process.exit(1)
  }
}

// Clean up intermediate blobs.
for (const bin of BINARIES) {
  try { unlinkSync(join(ROOT, bin.blob)) } catch {}
}

console.log('\nSEA compilation complete.')
for (const target of targets) {
  for (const bin of BINARIES) {
    const outfile = `dist/${bin.name}-${target.name}${target.ext}`
    if (existsSync(join(ROOT, outfile))) {
      const size = statSync(join(ROOT, outfile)).size
      console.log(`  ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`)
    }
  }
}
