# MiniMax OAuth (Clawdbot plugin)

OAuth provider plugin for **MiniMax** (free-tier OAuth).

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
clawdbot plugins enable minimax-portal-auth
```

Restart the Gateway after enabling.

## Authenticate

```bash
clawdbot models auth login --provider minimax-portal --set-default
```

## Notes

- MiniMax OAuth uses a device-code login flow.
- Tokens auto-refresh; re-run login if refresh fails or access is revoked.
