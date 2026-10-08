/**
 * `/secret` command: hand the channel's agent a sensitive string (e.g. an OAuth
 * redirect URL) without it ever appearing in the channel.
 *
 * Both inputs are collected in a Discord MODAL (popup) so even the secret's
 * name stays private: a required multiline "secret" value and an optional short
 * "name". On submit the value is delivered out-of-band to the channel's agent
 * box (never in the message text or in any log), written to the box's own
 * ephemeral `/tmp/secrets/<name>` (0600), and the agent is told via a one-off
 * `<system-reminder>` where to read it.
 *
 * This module is transport-agnostic: it only builds the modal payload, parses
 * the submission, sanitizes the name, and formats the reminder. The router
 * adapter in gateway-events.ts drives Discord and the box RPC.
 */

import { createHash } from "node:crypto";

/** Slash-command registration body for Discord. */
export const SECRET_COMMAND_SPEC = {
  name: "secret",
  description: "Privately hand this channel's agent a sensitive value (collected via a popup)",
  type: 1, // CHAT_INPUT
  // Allow use in guilds (0) and one-to-one bot DMs (1) only. Group DMs (2) are
  // deliberately excluded: they have no `guild_id` to owner-gate on yet carry
  // multiple participants, so any member could otherwise hand the agent a secret.
  contexts: [0, 1],
};

/** custom_id of the `/secret` modal (and the dispatch key for its submission). */
export const SECRET_MODAL_CUSTOM_ID = "secret-modal";
/** custom_id of the required multiline value input inside the modal. */
export const SECRET_VALUE_INPUT_ID = "secret-value";
/** custom_id of the optional short name input inside the modal. */
export const SECRET_NAME_INPUT_ID = "secret-name";

/** Max length of a sanitized secret name (filesystem-friendly, bounded). */
export const MAX_SECRET_NAME_LENGTH = 48;

/** A Discord TextInput component (component type 4). */
type DiscordTextInput = {
  type: 4;
  custom_id: string;
  /** 1 short (single line), 2 paragraph (multiline). */
  style: 1 | 2;
  label: string;
  required: boolean;
  max_length?: number;
  placeholder?: string;
};

/** A Discord modal action row wrapping exactly one text input. */
type DiscordModalRow = { type: 1; components: [DiscordTextInput] };

/** A Discord MODAL interaction response payload (callback type 9). */
export type DiscordModal = {
  custom_id: string;
  title: string;
  components: DiscordModalRow[];
};

/**
 * Build the `/secret` modal payload. The value input is a required multiline
 * (paragraph) field; the name input is an optional single-line field. Each
 * input must live in its own action row (Discord allows one input per row).
 */
export function buildSecretModal(): DiscordModal {
  return {
    custom_id: SECRET_MODAL_CUSTOM_ID,
    title: "Hand the agent a secret",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: SECRET_VALUE_INPUT_ID,
            style: 2, // paragraph (multiline)
            label: "Secret value",
            required: true,
            max_length: 4000,
            placeholder: "e.g. an OAuth redirect URL or token",
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: SECRET_NAME_INPUT_ID,
            style: 1, // short (single line)
            label: "Name (optional)",
            required: false,
            max_length: 64,
            placeholder: "defaults to a hash of the value",
          },
        ],
      },
    ],
  };
}

/** The raw shape of a MODAL_SUBMIT interaction's `data.components` tree. */
type ModalSubmitComponents = Array<{
  components?: Array<{ custom_id?: string; value?: string }>;
}>;

/** A parsed `/secret` modal submission. */
export type SecretSubmission = { value: string; name: string };

/**
 * Extract the value and name from a MODAL_SUBMIT interaction's component tree.
 * Discord nests each input one level under an action row, keyed by custom_id.
 * The name defaults to an empty string when the optional input was left blank.
 */
export function parseSecretModalSubmit(components: ModalSubmitComponents | undefined): {
  value: string;
  name: string;
} {
  const flat = new Map<string, string>();
  for (const row of components ?? []) {
    for (const comp of row.components ?? []) {
      if (typeof comp.custom_id === "string" && typeof comp.value === "string") {
        flat.set(comp.custom_id, comp.value);
      }
    }
  }
  return {
    value: flat.get(SECRET_VALUE_INPUT_ID) ?? "",
    name: flat.get(SECRET_NAME_INPUT_ID) ?? "",
  };
}

/**
 * Sanitize a user-supplied secret name into a safe, stable filename token:
 * lowercase, keep only `[a-z0-9]`, hyphen, and underscore (everything else
 * stripped), capped at {@link MAX_SECRET_NAME_LENGTH}. Hyphen/underscore are
 * filename- and path-safe (no shell metacharacters, no `/`, cannot form `..`).
 * When the result is empty (name omitted or entirely stripped), derive a
 * deterministic fallback from the value: `secret-<first 8 hex of sha256(value)>`.
 * Two submissions with the same resolved name target the same path, so
 * re-submitting overwrites in place.
 */
export function sanitizeSecretName(raw: string, value: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, MAX_SECRET_NAME_LENGTH);
  if (cleaned) {
    return cleaned;
  }
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `secret-${hash}`;
}

/**
 * A per-channel scope token used to nest secrets under their own subdirectory so
 * two sessions cannot read or overwrite each other's same-named secret. Sandbox
 * scope defaults to `agent`, which maps every `agent:main:...` channel to one
 * shared container; direct mode shares the gateway host. Nesting by this token
 * (a stable `[a-z0-9]` hash of the channel id) keeps each channel's secrets
 * isolated in both cases. The token is `[a-z0-9]` so it is injection-safe when
 * interpolated into the sandbox shell script.
 */
export function secretScopeToken(channelId: string): string {
  return `ch${createHash("sha256").update(channelId).digest("hex").slice(0, 16)}`;
}

/** Absolute path a secret named `name` is written to inside the agent box. */
export function secretPath(name: string, scopeToken: string): string {
  return `/tmp/secrets/${scopeToken}/${name}`;
}

/**
 * The one-off instruction (to be wrapped in a `<system-reminder>` by the
 * routing layer) telling the agent a secret is available on disk. Never includes
 * the secret value.
 *
 * IMPORTANT framing: the delivery keeps the value out of the chat/message text,
 * but a shell/exec tool result IS persisted to the session transcript. So the
 * reminder steers the agent to CONSUME the file BY PATH (pass the path to the
 * command that needs it) rather than printing its contents, and warns that
 * `cat`-ing it would copy the value into the transcript. That keeps the secret
 * off the wire and out of the transcript in the normal case.
 */
export function secretReminderMessage(name: string, scopeToken: string): string {
  const path = secretPath(name, scopeToken);
  return (
    `A secret named "${name}" has been made available to you at ${path}. ` +
    `It was provided privately by the user and is not shown in the chat. ` +
    `This file is temporary and may not persist across restarts. ` +
    `Use it by passing the file PATH to whatever needs it (for example ` +
    `\`curl --data @${path} ...\` or reading it inside a single command), ` +
    `rather than printing or \`cat\`-ing it: your tool output is saved to the ` +
    `conversation transcript, so echoing the value would copy it there. ` +
    `Never send its contents back into the channel.`
  );
}
