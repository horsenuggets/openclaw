# Local "fake prod host" for the OpenClaw docker test rig.
#
# A single privileged container that mirrors the WSL production host: Ubuntu +
# Docker Engine + compose plugin, so it can run the REAL deploy pipeline
# (deploy.sh -> setup.sh -> boot.sh) and spin up the router + provisioner +
# per-channel agent containers INSIDE itself (docker-in-docker). Because the
# inner Docker daemon is a real Linux daemon, the router's `network_mode: host`
# and the agent `oc-agents` bridge both work, so the prod compose files run
# unmodified and the router<->agent<->proxy mesh (boxes reach the host-networked
# router's proxies at the bridge gateway IP) behaves exactly like prod (unlike a
# bare container on macOS Docker Desktop).
#
# Built and driven by scripts/prod-mirror.sh; not meant to be run by hand.
FROM ubuntu:24.04

# Ubuntu + Docker Engine (dockerd + compose plugin) to match the prod host, plus
# python3 (boot.sh/openclawctl use it), openssh-server (deploy.sh ships over ssh
# and the mint tunnel terminates here), and iproute2 for host-net tooling.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg python3 openssh-server iproute2 \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
    >/etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-compose-plugin \
  && rm -rf /var/lib/apt/lists/* \
  # sshd: key-only root login (deploy.sh/mint authenticate with the rig keypair).
  && mkdir -p /run/sshd /root/.ssh \
  && chmod 700 /root/.ssh \
  && printf 'PermitRootLogin prohibit-password\nPubkeyAuthentication yes\nPasswordAuthentication no\n' \
    >/etc/ssh/sshd_config.d/prod-mirror.conf

# Fresh anonymous volume per run so the inner dockerd gets an ext4-backed
# /var/lib/docker where overlay2 works (the container's own overlayfs rootfs
# does not support nesting overlay2).
VOLUME /var/lib/docker

COPY prod-mirror-entrypoint.sh /usr/local/bin/prod-mirror-entrypoint.sh
RUN chmod +x /usr/local/bin/prod-mirror-entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/prod-mirror-entrypoint.sh"]
