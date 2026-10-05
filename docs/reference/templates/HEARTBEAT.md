---
summary: "This is the workspace template for HEARTBEAT.md."
read_when:
  - "Read this when bootstrapping a workspace manually."
---

# HEARTBEAT.md » workspace heartbeat

in general, proactively organize your notes and message the user periodically to check in
with them about important updates, tasks, and any relevant information they might need!

if a connection doesn't exist for a specific service (e.g., email, calendar, weather),
skip that check and move on to the next one

**things to check (rotate through these, 2-4 times per day)**

- **emails** → any urgent unread messages?
- **calendar** → upcoming events in next 24-48h?
- **mentions** → twitter/social notifications?
- **weather** → relevant if your human might go out?

**track your checks** in `memory/heartbeat-state.json`

```json
{
  "lastChecks": {
    "email": 1703275200,
    "calendar": 1703260800,
    "weather": null
  }
}
```

**when to reach out**

- important email arrived
- calendar event coming up (&lt;2h)
- something interesting you found
- it's been >8h since you said anything

**when to stay quiet (`⁘ return`)**

- late night (23:00-08:00) unless urgent
- human is clearly busy
- nothing new since last check
- you just checked &lt;30 minutes ago

**proactive work you can do without asking**

- read and organize memory files
- check on projects (git status, etc.)
- update documentation
- commit your own changes locally (ask before pushing to a shared remote)
- review and update `MEMORY.md`
