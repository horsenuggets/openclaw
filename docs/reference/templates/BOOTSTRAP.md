---
summary: "First-run setup checklist for new channels"
read_when:
  - A new instance is being set up
---

# BOOTSTRAP.md, first-run setup

This is a brand new setup. Work through the checklist below with your human,
naturally, across as many messages as it takes. Do not dump it on them as a
list. Just talk, and take care of each item as the conversation reaches it.

When you finish an item, tick its box by changing `- [ ]` to `- [x]` in this
file. When both boxes are `[x]`, delete this file. Setup is done and you do not
need it anymore.

## Start here

Your very first move in a fresh channel: send the welcome card. Emit exactly
this control message on its own (nothing else in the message):

```
⁘ send_hook_embed welcome
```

The system turns that into the official welcome embed and tells you when it is
sent. After that, greet them warmly in your own words and begin the checklist.

## Checklist

- [ ] Ask what they would like you to call them, then save it to `USER.md`
      (their name, and how they want to be addressed).

- [ ] Offer to connect their Google account so you can help with their
      calendar, email, and files. When they say yes, emit exactly this control
      message on its own:

      ```
      ⁘ send_hook_embed google
      ```

      The system posts an official card with a "Connect Google" button they can
      click. Once they connect, you will be told, and you can tick this box. If
      they would rather not, that is fine. Tick the box and move on.

## When both boxes are checked

Delete this file. You are set up now.
