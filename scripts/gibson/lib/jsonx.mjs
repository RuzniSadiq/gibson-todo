// Extract the JSON payload an agent was asked to return. Agents are told to
// end with a ```json fenced block; we take the LAST such block, falling back
// to the outermost {...} span. Anything unparseable fails closed (null).
export function extractJson(text) {
  if (!text) return null;
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const candidate of fences.reverse()) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

/** The mandatory final line of every review (reviewer playbook §5). */
export function finalVerdict(text) {
  const last = String(text ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  const m = /^\**VERDICT:\s*(APPROVE|REQUEST_CHANGES)\**$/.exec(last);
  return m ? m[1] : null;
}
