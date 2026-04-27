#!/usr/bin/env node

/**
 * Compile OpenClaw into standalone binaries for distribution.
 *
 * Requires Bun to be installed. Builds the project first (tsdown),
 * then compiles the entry point into standalone binaries using
 * `bun build --compile`.
 *
 * Native addons (sharp) are excluded from the binary and must be
 * shipped alongside it or installed on the target.
 *
 * Usage:
 *   node scripts/compile.mjs                        # Build all platforms
 *   node scripts/compile.mjs --target linux-x64     # Build one platform
 *   node scripts/compile.mjs --skip-build           # Skip tsdown, compile only
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

function walkJsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsFiles(full));
    } else if (entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

const TARGETS = [
  { name: "linux-arm64", bunTarget: "bun-linux-arm64" },
  { name: "linux-x64", bunTarget: "bun-linux-x64" },
  { name: "macos-arm64", bunTarget: "bun-darwin-arm64" },
  { name: "macos-x64", bunTarget: "bun-darwin-x64" },
  { name: "windows-arm64", bunTarget: "bun-windows-arm64" },
  { name: "windows-x64", bunTarget: "bun-windows-x64" },
];

// Native addons and platform-specific packages that cannot be embedded.
// These must be available on the target system or shipped alongside.
const EXTERNAL_MODULES = [
  // Image processing (native C++ addon)
  "sharp",
  "@img/sharp-*",
  // LLM inference (platform-specific native bindings)
  "node-llama-cpp",
  "@node-llama-cpp/*",
  // Browser automation (playwright needs full install with browsers)
  "playwright",
  "electron",
  // Other native modules
  "@xenova/*",
  "onnxruntime-node",
];

// Parse flags
const args = process.argv.slice(2);
const targetArg = args.indexOf("--target");
const selectedTarget = targetArg !== -1 ? args[targetArg + 1] : undefined;
const skipBuild = args.includes("--skip-build");

if (selectedTarget && !TARGETS.find((t) => t.name === selectedTarget)) {
  console.error(
    `Unknown target: ${selectedTarget}\nValid targets: ${TARGETS.map((t) => t.name).join(", ")}`,
  );
  process.exit(1);
}

const targets = selectedTarget ? TARGETS.filter((t) => t.name === selectedTarget) : TARGETS;

// Step 1: Build with tsdown (produces dist/)
if (!skipBuild) {
  console.log("Building with tsdown...");
  execSync("pnpm build", { stdio: "inherit" });
}

if (!existsSync("dist/entry.js")) {
  console.error("Build failed: dist/entry.js not found");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

// Step 2: Replace __OPENCLAW_VERSION__ in all dist chunks.
// Bun's --define only applies to the entry file, not code-split chunks.
// Do a literal text replacement so the version is inlined everywhere.
{
  let replaced = 0;
  for (const filePath of walkJsFiles("dist")) {
    let content = readFileSync(filePath, "utf-8");
    if (content.includes("__OPENCLAW_VERSION__")) {
      content = content.replace(/__OPENCLAW_VERSION__/g, JSON.stringify(pkg.version));
      writeFileSync(filePath, content);
      replaced++;
    }
  }
  console.log(`Replaced __OPENCLAW_VERSION__ in ${replaced} chunk(s)`);
}

// Step 3: Generate standalone binary wrapper entry point.
// The @mariozechner/pi-coding-agent config.js detects Bun binaries and reads
// package.json from dirname(process.execPath) or PI_PACKAGE_DIR. Since the
// compiled binary is standalone (no files shipped alongside), we generate a
// wrapper that writes a temporary package.json and sets the env var before
// any modules load.
// Generate environment setup module (must run before plugin-sdk loads).
// pi-coding-agent reads package.json at import time with no try/catch;
// PI_PACKAGE_DIR redirects it to a temp dir with a generated package.json.
const setupEntry = `dist/binary-setup-env.js`;
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
  ].join("\n") + "\n",
);

// Generate the main binary entry.
// Static imports are evaluated in declaration order (for non-circular deps):
// 1. binary-setup-env.js sets PI_PACKAGE_DIR (only uses node: builtins)
// 2. plugin-sdk/index.js loads, populates globalThis for extension shims
// 3. Module body dynamically imports entry.js to start the CLI
const wrapperEntry = `dist/binary-entry.js`;
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
  ].join("\n") + "\n",
);
console.log(`Generated ${wrapperEntry} (standalone binary entry)`);

// Step 4: Create shims for optional native dependencies that aren't installed.
// playwright-core references chromium-bidi (optional peer dep) which pnpm
// doesn't hoist. Create empty shims next to playwright-core so bun can
// resolve and bundle them into the standalone binary.
{
  const pwCoreDirs = readdirSync("node_modules/.pnpm")
    .filter((d) => d.startsWith("playwright-core@"))
    .map((d) => `node_modules/.pnpm/${d}/node_modules`);
  const pwDir = pwCoreDirs[0];
  if (!pwDir) {
    console.log("playwright-core not found, skipping chromium-bidi shims");
  } else {
    const shimPaths = [
      `${pwDir}/chromium-bidi/package.json`,
      `${pwDir}/chromium-bidi/index.js`,
      `${pwDir}/chromium-bidi/lib/cjs/bidiMapper/BidiMapper.js`,
      `${pwDir}/chromium-bidi/lib/cjs/cdp/CdpConnection.js`,
    ];
    for (const p of shimPaths) {
      const dir = p.substring(0, p.lastIndexOf("/"));
      if (!existsSync(dir)) {
        execSync(`mkdir -p "${dir}"`, { stdio: "pipe" });
      }
    }
    if (!existsSync(`${pwDir}/chromium-bidi/index.js`)) {
      writeFileSync(
        `${pwDir}/chromium-bidi/package.json`,
        '{"name":"chromium-bidi","version":"0.0.0-shim","main":"index.js"}\n',
      );
      writeFileSync(`${pwDir}/chromium-bidi/index.js`, "module.exports = {};\n");
      writeFileSync(
        `${pwDir}/chromium-bidi/lib/cjs/bidiMapper/BidiMapper.js`,
        "module.exports = {};\n",
      );
      writeFileSync(
        `${pwDir}/chromium-bidi/lib/cjs/cdp/CdpConnection.js`,
        "module.exports = {};\n",
      );
      console.log("Created chromium-bidi shims for standalone binary");
    }
  }
}

// Step 5: Copy and pre-compile extensions (must happen before binary compilation
// so embedded plugins can be included in the binary).
// Step 6 (below) then compiles the binaries with extensions embedded.
// The binary looks for extensions/ next to the executable.
// Ship the full extensions directory alongside the binary.
if (existsSync("extensions")) {
  console.log("\nCopying extensions...");
  // Remove old copy — pnpm hardlinks/symlinks can resist rm -rf,
  // so move to tmp and let the OS garbage-collect it
  if (existsSync("dist/extensions")) {
    const tmpDir = `${process.env.TMPDIR ?? "/tmp"}/openclaw-ext-cleanup-${Date.now()}`;
    execSync(`mv dist/extensions "${tmpDir}" && rm -rf "${tmpDir}" &`, {
      stdio: "inherit",
      shell: true,
    });
  }
  // Copy only source files (skip node_modules and build caches)
  execSync("rsync -a --exclude='node_modules' --exclude='.builds' extensions/ dist/extensions/", {
    stdio: "inherit",
  });
  // Pre-compile TypeScript extensions to JS so jiti/babel isn't needed at runtime.
  // Also rewrite package.json entry points from .ts to .js.
  console.log("  Pre-compiling extensions...");
  let compiledCount = 0;
  let failedCount = 0;
  for (const extDir of readdirSync("dist/extensions")) {
    const extPath = `dist/extensions/${extDir}`;
    const indexTs = `${extPath}/index.ts`;
    if (!existsSync(indexTs)) {
      continue;
    }
    try {
      execSync(
        `bun build "${indexTs}" --outdir "${extPath}" --target node --external openclaw --external "openclaw/*"`,
        { stdio: "pipe" },
      );
      // Rewrite package.json to point to .js instead of .ts
      const pkgPath = `${extPath}/package.json`;
      if (existsSync(pkgPath)) {
        let content = readFileSync(pkgPath, "utf-8");
        content = content.replace(/\.\/index\.ts/g, "./index.js");
        content = content.replace(/\.\/src\//g, "./src/");
        writeFileSync(pkgPath, content);
      }
      compiledCount++;
    } catch {
      console.log(`    Warning: failed to pre-compile ${extDir}`);
      failedCount++;
    }
  }
  console.log(`  Extensions: ${compiledCount} compiled, ${failedCount} failed`);

  // Create node_modules shim so extensions can resolve "openclaw/plugin-sdk"
  // via standard Node module resolution. The shim delegates to a global that
  // binary-entry.js pre-populates with the real bundled plugin-sdk module.
  const shimPkgDir = "dist/extensions/node_modules/openclaw";
  const shimSdkDir = `${shimPkgDir}/plugin-sdk`;
  execSync(`mkdir -p "${shimSdkDir}"`, { stdio: "pipe" });
  writeFileSync(
    `${shimPkgDir}/package.json`,
    '{"name":"openclaw","exports":{"./plugin-sdk":"./plugin-sdk/index.js"}}\n',
  );
  writeFileSync(`${shimSdkDir}/index.js`, "module.exports = globalThis.__OPENCLAW_PLUGIN_SDK__;\n");
  console.log("  Created openclaw/plugin-sdk shim in extensions/node_modules/");

  // Generate embedded plugins module that statically imports all compiled extensions.
  // This allows bun --compile to include them in the binary.
  const embeddedImports = [];
  const embeddedRegistrations = [];
  // Extensions that fail to load as embedded (legacy export patterns, import issues).
  // These still load from the extensions/ directory fallback.
  const EMBEDDED_SKIP = new Set(["lobster", "open-prose"]);
  for (const extDir of readdirSync("dist/extensions").toSorted()) {
    const indexJs = `dist/extensions/${extDir}/index.js`;
    if (!existsSync(indexJs) || extDir === "node_modules" || EMBEDDED_SKIP.has(extDir)) {
      continue;
    }
    const varName = `ext_${extDir.replace(/[^a-zA-Z0-9]/g, "_")}`;
    embeddedImports.push(`import ${varName} from "./extensions/${extDir}/index.js";`);
    embeddedRegistrations.push(`  ["${extDir}", ${varName}],`);
  }
  const embeddedEntry = "dist/binary-embedded-plugins.js";
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
    ].join("\n"),
  );
  console.log(`  Generated ${embeddedEntry} (${embeddedRegistrations.length} extensions embedded)`);
}

// Step 6: Compile binaries (after extensions are embedded)
const externals = EXTERNAL_MODULES.map((m) => `--external ${m}`).join(" ");

console.log(`\nCompiling ${targets.length} target(s)...`);

for (const target of targets) {
  const isWindows = target.name.startsWith("windows");
  const outfile = `dist/openclaw-${target.name}${isWindows ? ".exe" : ""}`;
  console.log(`  ${target.name} -> ${outfile}`);

  try {
    execSync(
      `bun build ${wrapperEntry} --compile --target=${target.bunTarget} ${externals} --outfile ${outfile}`,
      { stdio: "inherit" },
    );
  } catch {
    console.error(`  Failed to compile for ${target.name}`);
    process.exit(1);
  }
}

// Step 6b: Compile discord-router standalone binary
console.log(`\nCompiling discord-router for ${targets.length} target(s)...`);

for (const target of targets) {
  const isWindows = target.name.startsWith("windows");
  const routerOutfile = `dist/discord-router-${target.name}${isWindows ? ".exe" : ""}`;
  console.log(`  ${target.name} -> ${routerOutfile}`);

  try {
    execSync(
      `bun build src/discord-router/entry.ts --compile --target=${target.bunTarget} --outfile ${routerOutfile}`,
      { stdio: "inherit" },
    );
  } catch {
    console.error(`  Failed to compile discord-router for ${target.name}`);
  }
}

// Step 7: Copy workspace templates for agent system prompts.
// The binary resolves templates relative to process.execPath.
if (existsSync("docs/reference/templates")) {
  console.log("\nCopying workspace templates...");
  execSync("mkdir -p dist/docs/reference && cp -r docs/reference/templates dist/docs/reference/", {
    stdio: "inherit",
  });
  console.log("  Copied docs/reference/templates/");
}

// Summary
console.log("\nCompilation complete.");
for (const target of targets) {
  const isWindows = target.name.startsWith("windows");
  const outfile = `dist/openclaw-${target.name}${isWindows ? ".exe" : ""}`;
  if (existsSync(outfile)) {
    const size = statSync(outfile).size;
    console.log(`  ${outfile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}
