/**
 * Deterministic, server-side detection of a visitor asking to be helped by a
 * human. This is deliberately NOT delegated to the LLM — "request a human"
 * must work even when the model is down, misconfigured or hallucinating, and
 * it must never depend on a billed API call.
 *
 * The phrases are conservative (multi-word) so casual uses of words like
 * "agent" or "human" do not produce false escalations.
 */
const HUMAN_REQUEST_PATTERNS: RegExp[] = [
  /\btalk to (a|the|some|an)?\s*(real\s+)?(human|person|agent|team|personnel)\b/i,
  /\bspeak to (a|the|some|an)?\s*(real\s+)?(human|person|agent|team|personnel)\b/i,
  /\btalk with (a|the|some|an)?\s*(real\s+)?(human|person|agent|team)\b/i,
  /\bchat with (a|the|some|an)?\s*(real\s+)?(human|person|agent|team)\b/i,
  /\bsomeone (real|human|actual)\b/i,
  /\b(human|real|actual) (person|agent|support)\b/i,
  /\bcustomer service (representative|agent)\b/i,
  /\bsupport (representative|agent|staff|person)\b/i,
  /\brequest (a|an)?\s*human\b/i,
  /\bneed (a|an|the)?\s*(real\s+)?human\b/i,
  /\bget (a|an)?\s*human\b/i,
  /\bbe transferred to (a|an)?\s*(human|agent)\b/i,
];

/** True when the visitor is explicitly asking to be served by a human. */
export function isExplicitHumanRequest(content: string): boolean {
  return HUMAN_REQUEST_PATTERNS.some((pattern) => pattern.test(content));
}
