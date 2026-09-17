import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const openclawctlPath = path.join(repoRoot, "infrastructure/scripts/openclawctl");
const bootScriptPath = path.join(repoRoot, "infrastructure/deploy/boot.sh");
const setupScriptPath = path.join(repoRoot, "infrastructure/deploy/setup.sh");

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
  it("rolls back the port assignment when no template config exists", () => {
    const home = makeTempHome();
    // A docker stub so any accidental container start is observable (it must not
    // be reached: provisioning fails before start_container).
    writeExecutable(
      path.join(home, "bin", "docker"),
      ["#!/usr/bin/env bash", 'echo "$*" >> "$HOME/docker.log"', "exit 0", ""].join("\n"),
    );

    const result = spawnSync("bash", [openclawctlPath, "add-channel", "999"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    // Provisioning cannot produce a config, so the command must fail and roll back.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Rolling back registration for 999");
    // Port assignment must be released so a retry is not blocked as "already registered".
    const portsPath = path.join(home, ".openclaw-instances", "ports.json");
    if (fs.existsSync(portsPath)) {
      const ports = JSON.parse(fs.readFileSync(portsPath, "utf-8")) as {
        assignments: Record<string, number>;
      };
      expect(ports.assignments["999"]).toBeUndefined();
    }
    // The empty instance directory must be removed.
    expect(fs.existsSync(path.join(home, ".openclaw-instances", "999"))).toBe(false);
    // Container start must never have been attempted.
    const dockerLogPath = path.join(home, "docker.log");
    if (fs.existsSync(dockerLogPath)) {
      expect(fs.readFileSync(dockerLogPath, "utf-8")).not.toContain("compose -f");
    }
  });

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
        '  "ui": { "defaults": { "skipBootstrapFile": false, "theme": "dark" } },',
        "  // agent defaults",
        '  "agents": {',
        '    "nested": { "defaults": { "note": "ignore me" } },',
        '    "defaults": { /* keep JSON5 layout; skipBootstrapFile still missing here */ "workspace": "/home/node/.openclaw/workspaces/123", },',
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
    expect(raw).toContain('"skipBootstrapFile": false');
    expect(raw).toContain('"nested": { "defaults": { "note": "ignore me" } },');
    expect(raw).toContain(
      '"defaults": { /* keep JSON5 layout; skipBootstrapFile still missing here */ "skipBootstrapFile": true, "workspace": "/root/.openclaw/workspaces/123", },',
    );
    expect(raw).toContain('"skipBootstrapFile": true,');
    expect((raw.match(/"skipBootstrapFile"\s*:/g) ?? []).length).toBe(2);
    expect(raw.lastIndexOf('"skipBootstrapFile": true,')).toBeGreaterThan(raw.indexOf('"agents"'));
  });

  it("forces agents.defaults.skipBootstrapFile to true in JSON5 fallback", () => {
    const home = makeTempHome();
    const configPath = path.join(home, ".openclaw-instances", "123", "openclaw.json");
    writeFile(
      configPath,
      [
        "{",
        "  // valid JSON5 (comment + trailing comma) forces fallback path",
        '  "agents": {',
        '    "defaults": { "skipBootstrapFile": false, "workspace": "/home/node/.openclaw/workspaces/123", },',
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
    expect(raw).toContain('"skipBootstrapFile": true');
    expect(raw).not.toContain('"skipBootstrapFile": false');
    expect(raw).not.toContain("/home/node");
    expect(raw).toContain("/root/.openclaw/workspaces/123");
  });

  it("ignores an agents-like token inside a string value in JSON5 fallback", () => {
    const home = makeTempHome();
    const configPath = path.join(home, ".openclaw-instances", "123", "openclaw.json");
    // A preceding string value literally containing "agents: {" must not fool the
    // top-level property scan into corrupting the string or missing the real
    // agents.defaults object.
    writeFile(
      configPath,
      [
        "{",
        '  "description": "mentions agents: { defaults: fake }", // JSON5 comment',
        '  "agents": {',
        '    "defaults": { "workspace": "/home/node/.openclaw/workspaces/123", },',
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
    // The decoy string is untouched, the real path is repaired, and the flag is
    // inserted into the real agents.defaults object.
    expect(raw).toContain('"description": "mentions agents: { defaults: fake }"');
    expect(raw).not.toContain("/home/node");
    expect(raw).toContain("/root/.openclaw/workspaces/123");
    expect(raw).toContain('"skipBootstrapFile": true');
    expect((raw.match(/"skipBootstrapFile"\s*:/g) ?? []).length).toBe(1);
  });

  it("repairs only agents.defaults path fields in JSON5 fallback", () => {
    const home = makeTempHome();
    const configPath = path.join(home, ".openclaw-instances", "123", "openclaw.json");
    writeFile(
      configPath,
      [
        "{",
        '  "note": "/home/node/leave-me-alone",',
        '  "channels": { "discord": { "prompt": "example /home/node/path" } },',
        "  // valid JSON5 forces fallback",
        '  "agents": {',
        '    "defaults": {',
        '      "workspace": "/home/node/.openclaw/workspaces/123",',
        '      "memorySearch": { "local": { "modelCacheDir": "/home/node/.openclaw/models", }, },',
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
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(raw).toContain('"note": "/home/node/leave-me-alone"');
    expect(raw).toContain('"prompt": "example /home/node/path"');
    expect(raw).toContain('"workspace": "/root/.openclaw/workspaces/123"');
    expect(raw).toContain('"modelCacheDir": "/root/.openclaw/models"');
    expect(raw).toContain('"skipBootstrapFile": true');
  });

  it("fails sanitize-configs when a config cannot be written", () => {
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
        { agents: { defaults: { workspace: "/home/node/.openclaw/workspaces/123" } } },
        null,
        2,
      )}\n`,
    );
    // Make the config unwritable so the sanitizer emits "error" (a write failure
    // must not be silently counted as "unchanged" and allowed to boot stale).
    fs.chmodSync(configPath, 0o444);
    fs.chmodSync(instanceDir, 0o555);

    const result = spawnSync("bash", [openclawctlPath, "sanitize-configs"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: home },
    });

    // Restore perms so afterEach cleanup can remove the temp dir.
    fs.chmodSync(instanceDir, 0o755);
    fs.chmodSync(configPath, 0o644);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("errored=1");
    expect(result.stderr).toContain("failed to sanitize");
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

  it("aborts restart (does not remove the container) when legacy data copy fails", () => {
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
        { agents: { defaults: { workspace: "/home/node/.openclaw/workspaces/123" } } },
        null,
        2,
      )}\n`,
    );
    // docker: container exists, but `docker cp` fails. Preservation must fail and
    // the container must NOT be stopped/removed (its legacy data is the only copy).
    writeExecutable(
      path.join(home, "bin", "docker"),
      [
        "#!/usr/bin/env bash",
        'echo "$*" >> "$HOME/docker.log"',
        'if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then exit 0; fi',
        'if [ "$1" = "cp" ]; then exit 1; fi',
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

    // repair-configs must report failure (errored) and never remove the container.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("errored=1");
    const dockerLog = fs.readFileSync(path.join(home, "docker.log"), "utf-8");
    expect(dockerLog).not.toContain("stop agents.channel-123");
    expect(dockerLog).not.toContain("rm agents.channel-123");
    expect(dockerLog).not.toContain("compose -f");
  });

  it("preserves legacy container data during sanitize-configs without restarting", () => {
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
        '  printf "legacy memory\\n" > "$dest/MEMORY.md"',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      "bash",
      [openclawctlPath, "sanitize-configs", "--preserve-legacy-data"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${path.join(home, "bin")}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(instanceDir, "MEMORY.md"), "utf-8")).toContain(
      "legacy memory",
    );
    const dockerLog = fs.readFileSync(path.join(home, "docker.log"), "utf-8");
    expect(dockerLog).toContain("container inspect agents.channel-123");
    expect(dockerLog).toContain("cp agents.channel-123:/home/node/.openclaw/. ");
    expect(dockerLog).not.toContain("stop agents.channel-123");
    expect(dockerLog).not.toContain("compose -f");
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
      [
        "#!/usr/bin/env bash",
        'echo "$*" >> "$HOME/docker.log"',
        'if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then exit 0; fi',
        'if [ "$1" = "cp" ]; then exit 0; fi',
        "exit 0",
        "",
      ].join("\n"),
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
    expect(result.stdout).toContain("Preserving legacy /home/node/.openclaw data for 123...");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      agents: { defaults: { workspace: string; skipBootstrapFile: boolean } };
    };
    expect(config.agents.defaults.workspace).toBe("/root/.openclaw/workspaces/123");
    expect(config.agents.defaults.skipBootstrapFile).toBe(true);
    const dockerLog = fs.readFileSync(path.join(home, "docker.log"), "utf-8");
    expect(dockerLog).toContain("container inspect agents.channel-123");
    expect(dockerLog).toContain("cp agents.channel-123:/home/node/.openclaw/. ");
    expect(dockerLog).toContain("stop agents.channel-123");
    expect(dockerLog).toContain("compose -f");
    expect(dockerLog.indexOf("cp agents.channel-123:/home/node/.openclaw/. ")).toBeLessThan(
      dockerLog.indexOf("stop agents.channel-123"),
    );
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
    const dockerLogPath = path.join(home, "docker.log");
    if (fs.existsSync(dockerLogPath)) {
      expect(fs.readFileSync(dockerLogPath, "utf-8")).not.toContain("compose -f");
    }
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

  it("setup preserves legacy data before removing containers", () => {
    const home = makeTempHome();
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-setup-test-"));
    tempDirs.push(stagingDir);
    writeFile(path.join(stagingDir, ".env"), "TEST=1\n");
    writeFile(
      path.join(stagingDir, "boot.sh"),
      '#!/usr/bin/env bash\necho "boot" >> "$HOME/boot.log"\n',
    );
    writeExecutable(
      path.join(stagingDir, "deploy", "bin", "openclawctl"),
      [
        "#!/usr/bin/env bash",
        'echo "openclawctl $*" >> "$HOME/operations.log"',
        'echo "$*" >> "$HOME/openclawctl.log"',
        "exit 0",
        "",
      ].join("\n"),
    );
    writeFile(path.join(stagingDir, "deploy", "docker", "agent.yml"), "services: {}\n");
    writeExecutable(
      path.join(home, "bin", "docker"),
      [
        "#!/usr/bin/env bash",
        'echo "docker $*" >> "$HOME/operations.log"',
        'echo "$*" >> "$HOME/docker.log"',
        'if [ "$1" = "ps" ]; then echo "cid123"; exit 0; fi',
        "exit 0",
        "",
      ].join("\n"),
    );

    const result = spawnSync("bash", [setupScriptPath], {
      cwd: stagingDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${path.join(home, "bin")}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(home, "openclawctl.log"), "utf-8")).toContain(
      "sanitize-configs --preserve-legacy-data",
    );
    const operationsLog = fs.readFileSync(path.join(home, "operations.log"), "utf-8");
    expect(operationsLog).toContain("openclawctl sanitize-configs --preserve-legacy-data");
    const dockerLog = fs.readFileSync(path.join(home, "docker.log"), "utf-8");
    expect(dockerLog).toContain("stop cid123");
    expect(dockerLog).toContain("rm cid123");
    expect(
      operationsLog.indexOf("openclawctl sanitize-configs --preserve-legacy-data"),
    ).toBeLessThan(operationsLog.indexOf("docker stop cid123"));
    expect(fs.readFileSync(path.join(home, "boot.log"), "utf-8")).toContain("boot");
  });
});
