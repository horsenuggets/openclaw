import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const openclawctlPath = path.join(repoRoot, "infrastructure/scripts/openclawctl");
const bootScriptPath = path.join(repoRoot, "infrastructure/deploy/boot.sh");

const tempDirs: string[] = [];

function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclawctl-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function writeExecutable(filePath: string, content: string) {
  writeFile(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("openclawctl provisioning", () => {
  it("sanitizes existing copied configs without restarting containers", () => {
    const home = makeTempHome();
    const configPath = path.join(home, ".openclaw-instances", "123", "openclaw.json");
    writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: {
            defaults: {
              workspace: "/home/node/.openclaw/workspaces/123",
              memorySearch: {
                local: {
                  modelCacheDir: "/home/node/.openclaw/models",
                },
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync("bash", [openclawctlPath, "sanitize-configs"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Repaired config for 123");
    expect(result.stdout).toContain("repaired=1");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      agents: {
        defaults: {
          workspace: string;
          skipBootstrapFile: boolean;
          memorySearch: { local: { modelCacheDir: string } };
        };
      };
    };
    expect(config.agents.defaults.workspace).toBe("/root/.openclaw/workspaces/123");
    expect(config.agents.defaults.memorySearch.local.modelCacheDir).toBe("/root/.openclaw/models");
    expect(config.agents.defaults.skipBootstrapFile).toBe(true);
  });

  it("ignores unregistered instance dirs that are missing openclaw.json", () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, ".openclaw-instances", "123"), { recursive: true });

    const result = spawnSync("bash", [openclawctlPath, "sanitize-configs"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("missing=0");
    expect(result.stdout).toContain("missingUnregistered=1");
  });

  it("fails sanitize-configs when a registered instance is missing openclaw.json", () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, ".openclaw-instances", "123"), { recursive: true });
    writeFile(
      path.join(home, ".openclaw-instances", "ports.json"),
      `${JSON.stringify({ basePort: 18789, assignments: { "123": 18789 } }, null, 2)}\n`,
    );

    const result = spawnSync("bash", [openclawctlPath, "sanitize-configs"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing=1");
    expect(result.stderr).toContain("missing openclaw.json for 1 registered instance");
  });

  it("repairs a JSON5 config (comments/trailing commas) without aborting", () => {
    const home = makeTempHome();
    const configPath = path.join(home, ".openclaw-instances", "123", "openclaw.json");
    // OpenClaw parses config as JSON5, so a config may legally contain comments
    // and trailing commas. The sanitizer must not crash on these (strict JSON
    // would); it should still repair the stale /home/node path and add the
    // bootstrap-file suppression without stripping JSON5 syntax.
    writeFile(
      configPath,
      [
        "{",
        "  // agent defaults",
        '  "agents": {',
        '    "defaults": {',
        '      "workspace": "/home/node/.openclaw/workspaces/123",',
        "    },",
        "  },",
        "}",
        "",
      ].join("\n"),
    );

    const result = spawnSync("bash", [openclawctlPath, "sanitize-configs"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Repaired config for 123");
    const raw = fs.readFileSync(configPath, "utf-8");
    // Stale path repaired, and JSON5 syntax (comment) preserved.
    expect(raw).toContain("/root/.openclaw/workspaces/123");
    expect(raw).not.toContain("/home/node");
    expect(raw).toContain("// agent defaults");
    expect(raw).toContain('"skipBootstrapFile": true,');
  });

  it("preserves legacy container data for a repaired stopped container", () => {
    const home = makeTempHome();
    const instanceDir = path.join(home, ".openclaw-instances", "123");
    const configPath = path.join(instanceDir, "openclaw.json");
    writeFile(
      path.join(home, ".openclaw-instances", "ports.json"),
      `${JSON.stringify({ basePort: 18789, assignments: { "123": 18789 } }, null, 2)}\n`,
    );
    writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: {
            defaults: {
              workspace: "/home/node/.openclaw/workspaces/123",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeExecutable(
      path.join(home, "bin", "docker"),
      [
        "#!/usr/bin/env bash",
        'echo "$*" >> "$HOME/docker.log"',
        'if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then exit 0; fi',
        'if [ "$1" = "cp" ]; then',
        '  dest="${@: -1}"',
        '  mkdir -p "$dest/memory"',
        '  printf "legacy memory\\n" > "$dest/MEMORY.md"',
        "  exit 0",
        "fi",
        'if [ "$1" = "exec" ]; then exit 1; fi',
        "exit 0",
        "",
      ].join("\n"),
    );

    const result = spawnSync("bash", [openclawctlPath, "repair-configs"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Preserved legacy data for 123.");
    expect(fs.readFileSync(path.join(instanceDir, "MEMORY.md"), "utf-8")).toContain(
      "legacy memory",
    );
    const dockerLog = fs.readFileSync(path.join(home, "docker.log"), "utf-8");
    expect(dockerLog).toContain("container inspect agents.channel-123");
    expect(dockerLog).toContain("cp agents.channel-123:/home/node/.openclaw/. ");
    expect(dockerLog).not.toContain("exec agents.channel-123");
  });

  it("sanitizes a registered channel config before restart", () => {
    const home = makeTempHome();
    const configPath = path.join(home, ".openclaw-instances", "123", "openclaw.json");
    writeFile(
      path.join(home, ".openclaw-instances", "ports.json"),
      `${JSON.stringify({ basePort: 18789, assignments: { "123": 18789 } }, null, 2)}\n`,
    );
    writeFile(
      configPath,
      `${JSON.stringify(
        {
          agents: {
            defaults: {
              workspace: "/home/node/.openclaw/workspaces/123",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeExecutable(
      path.join(home, "bin", "docker"),
      ["#!/usr/bin/env bash", 'echo "$*" >> "$HOME/docker.log"', "exit 0", ""].join("\n"),
    );

    const result = spawnSync("bash", [openclawctlPath, "restart", "123"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Sanitized config for 123 before start.");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      agents: { defaults: { workspace: string; skipBootstrapFile: boolean } };
    };
    expect(config.agents.defaults.workspace).toBe("/root/.openclaw/workspaces/123");
    expect(config.agents.defaults.skipBootstrapFile).toBe(true);
    expect(fs.readFileSync(path.join(home, "docker.log"), "utf-8")).toContain("compose -f");
  });

  it("fails restart when the registered channel config is missing", () => {
    const home = makeTempHome();
    writeFile(
      path.join(home, ".openclaw-instances", "ports.json"),
      `${JSON.stringify({ basePort: 18789, assignments: { "123": 18789 } }, null, 2)}\n`,
    );
    writeExecutable(
      path.join(home, "bin", "docker"),
      ["#!/usr/bin/env bash", 'echo "$*" >> "$HOME/docker.log"', "exit 0", ""].join("\n"),
    );

    const result = spawnSync("bash", [openclawctlPath, "restart", "123"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error: Missing config for 123");
    expect(fs.readFileSync(path.join(home, "docker.log"), "utf-8")).not.toContain("compose -f");
  });

  it("boot sanitizes configs before starting registered instances", () => {
    const home = makeTempHome();
    writeFile(
      path.join(home, ".openclaw-instances", "ports.json"),
      `${JSON.stringify({ basePort: 18789, assignments: { "123": 18789 } }, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(home, ".openclaw-instances", "123"), { recursive: true });
    writeExecutable(
      path.join(home, "deploy", "bin", "openclawctl"),
      ["#!/usr/bin/env bash", 'echo "$*" >> "$HOME/openclawctl.log"', "exit 0", ""].join("\n"),
    );
    writeExecutable(
      path.join(home, "bin", "docker"),
      ["#!/usr/bin/env bash", 'echo "$*" >> "$HOME/docker.log"', "exit 0", ""].join("\n"),
    );

    const result = spawnSync("bash", [bootScriptPath], {
      encoding: "utf-8",
      env: {
        ...process.env,
        DISCORD_BOT_TOKEN: "test-token",
        HOME: home,
        PATH: `${path.join(home, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(home, "openclawctl.log"), "utf-8").trim().split("\n")).toEqual(
      ["reconcile", "sanitize-configs"],
    );
    expect(fs.readFileSync(path.join(home, "docker.log"), "utf-8")).toContain("agents-123");
  });
});
