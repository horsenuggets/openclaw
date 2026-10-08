# Minimal per-channel agent box image: ubuntu:24.04 plus git and ca-certificates.
#
# git is here so the agent's /workspace is a real git repo it can commit to
# (`openclaw setup` runs `git init`; the seeded AGENTS.md tells the agent to commit
# its work). A generic, non-identifying system git identity lets the agent commit
# without any per-box configuration. ca-certificates keeps TLS working for anything
# the agent shells out to.
#
# Everything else the agent needs (the openclaw and gog binaries) stays a mounted
# binary (see agent.yml), so this image deliberately stays thin — add a tool here
# only when it genuinely cannot be a mounted binary.
#
# Built on the first `docker compose -f agent.yml up` via the build: stanza in
# agent.yml; compose caches the result. Changes to this file require a rebuild:
# `docker compose -f agent.yml build` or removing the openclaw-agent:latest image
# so the next up rebuilds it.
FROM ubuntu:24.04
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system user.name "OpenClaw Agent" \
  && git config --system user.email "agent@openclaw.local" \
  && git config --system init.defaultBranch main
