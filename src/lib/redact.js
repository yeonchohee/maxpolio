// Matches common secret-bearing assignments (YAML/.env/JSON/properties style)
// so real credentials never make it into an LLM prompt or a saved journal
// entry. Best-effort, not exhaustive - anything sensitive should still be
// kept out of tracked/diffed files and command output in the first place.
const SECRET_LINE_PATTERN =
  /^([^\n]*\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*)(["']?)([^\s"'\n]+)(["']?)/gim;

export function redactSecrets(text) {
  if (!text) return text;
  return text.replace(SECRET_LINE_PATTERN, "$1$2[REDACTED]$4");
}
