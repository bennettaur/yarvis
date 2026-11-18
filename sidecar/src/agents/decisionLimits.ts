/**
 * Limits on a decision specialist's prompt, shared by the catalogue, the ask
 * itself and the playground route so none of them drifts from the others.
 * Its own module so importing them pulls in nothing else.
 */

/**
 * A decision option is also a System One question name, so it keeps to the
 * characters the System One API accepts.
 */
export const CHOICE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/** System One asks one question per option, so the list stays short. */
export const MAX_OPTIONS = 20;

/**
 * Sized so instructions, input and every option description fit the 8k
 * context a decision call gets on Ollama, which drops overflow from the front,
 * where the instructions sit.
 */
export const MAX_INSTRUCTIONS_CHARS = 4_000;
export const MAX_INPUT_CHARS = 6_000;
export const MAX_OPTION_DESCRIPTION_CHARS = 300;
