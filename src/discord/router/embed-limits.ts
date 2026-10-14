/**
 * Discord's hard caps for embeds in a single message, shared by every multi-embed
 * builder (debug help, connections list, ...). Discord caps the combined text of
 * ALL embeds in one message at 6000 characters (title + description + every field
 * name/value + footer text), not per embed, and allows at most 10 embeds per
 * message, 25 fields per embed, 256 chars per field name, and 1024 chars per field
 * value. Overflowing to more embeds only buys room past the 25-field-per-embed
 * cap; it does not raise the message-wide character budget.
 */
export const MAX_MESSAGE_TOTAL_CHARS = 6000;
export const MAX_EMBEDS_PER_MESSAGE = 10;
export const MAX_FIELDS_PER_EMBED = 25;
export const MAX_FIELD_NAME_CHARS = 256;
export const MAX_FIELD_VALUE_CHARS = 1024;
