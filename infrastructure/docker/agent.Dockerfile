# Per-channel agent box image: ubuntu:24.04 plus a general-purpose toolchain so the
# agent can install and run connection tooling (CLIs, npx-based MCP servers, pip/pipx
# packages) at runtime. Runtime installs land in the writable, persistent /usr/local
# and /opt bind mounts (see agent.yml), so they survive restarts without needing root
# or a writable root filesystem.
#
# Why these tools form the baked floor rather than being installed at runtime: the box
# runs read-only, non-root (uid 1000), with all capabilities dropped, so `apt` cannot
# run inside it. Anything that must be installed as root, or that is a shared
# prerequisite for many skills (node, python, a compiler), belongs here in the image —
# updated for every box on the next deploy. Per-connection tools the agent pulls go to
# /usr/local at runtime instead.
#
# - git: /workspace is a real git repo the agent commits to (`openclaw setup` runs
#   `git init`; the seeded AGENTS.md tells it to commit). A generic, non-identifying
#   system identity lets it commit with no per-box config.
# - ca-certificates: TLS for anything the agent fetches.
# - nodejs + npm: run npx-based MCP servers and install JS CLIs. Installed from
#   NodeSource (Node 22.x) rather than Noble's distro package, which ships Node
#   18.19.1 — below OpenClaw's supported runtime baseline (Node 22.12+), so JS tooling
#   targeting that baseline can refuse to install or fail at runtime.
# - python3 + pip + pipx: install and isolate Python CLIs/tools.
# - curl, unzip, jq: fetch, unpack, and parse during installs.
# - build-essential: compile native deps some packages need.
#
# The openclaw and gog binaries stay mounted (see agent.yml), not baked here.
#
# Built on the first `docker compose -f agent.yml up` via the build: stanza in
# agent.yml; compose caches the result. Changes to this file require a rebuild:
# `docker compose -f agent.yml build` or removing the openclaw-agent:latest image
# so the next up rebuilds it.
FROM ubuntu:24.04
# Node 22.x from NodeSource (Noble's distro nodejs is 18.19.1, below the supported
# baseline). curl + ca-certificates are needed to fetch the NodeSource setup script,
# which adds the apt repo that provides nodejs (bundling npm) at the pinned major.
# The setup script is downloaded to a file as its own fail-checked step rather than
# piped into bash: with `curl ... | bash -`, a curl failure is masked (the pipe exits
# with bash's status, and bash on empty stdin exits 0), so NodeSource's repo would
# silently not be added and `apt-get install nodejs` would fall back to Noble's Node
# 18. A final assertion hard-fails the build if the installed major is not 22.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh \
  && bash /tmp/nodesource_setup.sh \
  && rm -f /tmp/nodesource_setup.sh \
  && apt-get install -y --no-install-recommends \
    git unzip jq \
    nodejs python3 python3-pip pipx build-essential \
  && node --version | grep -q '^v22\.' \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system user.name "OpenClaw Agent" \
  && git config --system user.email "agent@openclaw.local" \
  && git config --system init.defaultBranch main

# Rename the stock ubuntu account (uid/gid 1000) to openclaw so $HOME, `whoami`, `~`
# expansion, and passwd all read coherently (HOME is /home/openclaw, mounted at
# runtime). The uid/gid stay 1000:1000, so the host bind-mount ownership that
# openclawctl sets (chown 1000:1000) still matches; the container still runs as the
# numeric 1000:1000 (see agent.yml).
RUN usermod -l openclaw ubuntu \
  && groupmod -n openclaw ubuntu \
  && usermod -d /home/openclaw openclaw
