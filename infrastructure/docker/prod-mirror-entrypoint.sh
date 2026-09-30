#!/usr/bin/env bash
# Entrypoint for the prod-mirror "fake prod host" container.
# Brings up the inner Docker daemon and sshd, then stays alive. The actual
# OpenClaw deploy (deploy.sh -> setup.sh -> boot.sh) and the provisioner are
# driven in from scripts/prod-mirror.sh over ssh once this is ready.
set -euo pipefail

# Install the laptop's public key so deploy.sh/mint can ssh in as root. Passed
# by the driver as an env var rather than baked into the image (keeps the key
# out of image layers).
if [ -n "${AUTHORIZED_KEY:-}" ]; then
  mkdir -p /root/.ssh
  printf '%s\n' "$AUTHORIZED_KEY" >/root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi

# Host keys + sshd (key-only root login is configured in the image).
ssh-keygen -A >/dev/null 2>&1 || true
/usr/sbin/sshd

# Inner Docker daemon (this container runs --privileged).
dockerd >/var/log/dockerd.log 2>&1 &

echo "prod-mirror: waiting for inner dockerd..."
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    echo "prod-mirror: dockerd + sshd ready"
    break
  fi
  sleep 1
done
if ! docker info >/dev/null 2>&1; then
  echo "prod-mirror: dockerd did not come up; last log lines:" >&2
  tail -n 40 /var/log/dockerd.log >&2 || true
  exit 1
fi

# Keep PID 1 alive and stream the daemon log so `docker logs` shows it.
exec tail -f /var/log/dockerd.log
