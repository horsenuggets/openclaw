/**
 * `/secret` command: hand the channel's agent a sensitive string (e.g. an OAuth
 * redirect URL) without it ever appearing in the channel.
 *
 * Both inputs are collected in a Discord MODAL (popup) so even the secret's
 * name stays private: a required single-line "secret" value and an optional short
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
import { type BuiltEmbed, buildEmbed } from "./embed-categories.js";

/** Slash-command registration body for Discord. */
export const SECRET_COMMAND_SPEC = {
  name: "secret",
  description: "Privately hand this channel's agent a sensitive value (collected via a popup).",
  type: 1, // CHAT_INPUT
  // Allow use in guilds (0) and one-to-one bot DMs (1) only. Group DMs (2) are
  // deliberately excluded: they have no `guild_id` to owner-gate on yet carry
  // multiple participants, so any member could otherwise hand the agent a secret.
  contexts: [0, 1],
};

/** custom_id of the `/secret` modal (and the dispatch key for its submission). */
export const SECRET_MODAL_CUSTOM_ID = "secret-modal";
/** custom_id of the required single-line value input inside the modal. */
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
 * Build the `/secret` modal payload. Both inputs are single-line: a required
 * value field and an optional name field (secrets handed via `/secret` are
 * expected to be one-liners such as tokens or OAuth redirect URLs). Each input
 * must live in its own action row (Discord allows one input per row).
 */
export function buildSecretModal(): DiscordModal {
  return {
    custom_id: SECRET_MODAL_CUSTOM_ID,
    title: "Hand the agent a secret...",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: SECRET_NAME_INPUT_ID,
            style: 1, // short (single line)
            label: "Name",
            required: false,
            max_length: 64,
            placeholder: "Defaults to a hash of the value",
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: SECRET_VALUE_INPUT_ID,
            // Single-line: secrets handed via /secret are expected to be
            // one-liners (tokens, OAuth redirect URLs). Discord modals never mask
            // input, so the style does not affect how hidden the value is.
            style: 1,
            label: "Secret Value",
            required: true,
            max_length: 4000,
            placeholder: "e.g. an OAuth redirect URL or token",
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
 * Sanitize a user-supplied secret name into a safe, stable filename token: keep
 * only `[A-Za-z0-9]`, hyphen, and underscore (case preserved, everything else
 * stripped), capped at {@link MAX_SECRET_NAME_LENGTH}. Hyphen/underscore are
 * filename- and path-safe (no shell metacharacters, no `/`, cannot form `..`).
 * When the result is empty (name omitted or entirely stripped), derive a
 * deterministic fallback from the value: `SECRET_<first 8 uppercase hex of
 * sha256(value)>`. Two submissions with the same resolved name target the same
 * path, so re-submitting overwrites in place. Case is preserved, so on a
 * case-sensitive host (the production Docker box, Linux) names differing only in
 * case are distinct files; on a case-insensitive direct-mode host (e.g. default
 * macOS) they alias to the same file, overwriting exactly as a same-name
 * resubmit does. That overwrite is benign and consistent with the same-name
 * semantics above; we intentionally do not canonicalize case (names stay as
 * typed) or track cross-submission collisions here.
 */
export function sanitizeSecretName(raw: string, value: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, MAX_SECRET_NAME_LENGTH);
  if (cleaned) {
    return cleaned;
  }
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8).toUpperCase();
  return `SECRET_${hash}`;
}

/**
 * Absolute path a secret named `name` is written to inside the agent box. No
 * per-channel nesting is needed: a channel maps 1:1 to its own container, so the
 * box only ever holds this channel's secrets.
 */
export function secretPath(name: string): string {
  return `/tmp/secrets/${name}`;
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
export function secretReminderMessage(name: string): string {
  const path = secretPath(name);
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

/**
 * Build the "secret received" success embed (Secrets category). The name is a
 * sanitized label, never the value, so it is safe to show. Rendered when a
 * submission is accepted and queued for the channel's agent. The wording says
 * "queued for delivery" rather than "delivered" because the ack is sent as soon
 * as the turn is enqueued; the actual write into the agent box happens when that
 * turn runs and can still fail, so claiming completed delivery here would be a
 * false guarantee.
 */
export function buildSecretReceivedEmbed(name: string): BuiltEmbed {
  return buildEmbed({
    category: "secrets",
    title: "Secret Received!",
    description:
      `The secret \`${name}\` was received and queued for delivery to this ` +
      `channel's OpenClaw agent. Keep in mind that secrets are temporary and they ` +
      `can be overwritten.`,
  });
}

/**
 * Build a Secrets-category notice embed for a submission that could not be
 * accepted (missing value, unregistered channel, unsupported surface). Carries
 * only the fixed wording passed in, never the secret value.
 */
export function buildSecretNoticeEmbed(title: string, description: string): BuiltEmbed {
  return buildEmbed({ category: "secrets", title, description });
}
