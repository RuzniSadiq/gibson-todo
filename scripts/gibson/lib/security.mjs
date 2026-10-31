// Security layers implemented locally (AGENTS.md "Security layers"):
//   L1 secrets (hard-fail) · L3 supply chain (dependency diff, hard-fail on
//   new runtime deps without a declared need) · L7 AI-surface / prompt
//   injection (hard-fail => G16, stop the fleet).
// Patterns are deliberately conservative: a false positive costs one human
// look; a false negative leaks a credential or steers an agent.

const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['hard-coded credential', /\b(?:api[_-]?key|secret|passw(?:or)?d|auth[_-]?token)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/i],
];

const INJECTION_PATTERNS = [
  ['instruction override', /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts?)\b/i],
  ['role hijack', /\byou\s+are\s+now\s+(?:a|an|the|in)\b/i],
  ['reviewer steering', /\b(?:reviewers?|you)\s+(?:must|should)\s+(?:approve|output\s+VERDICT)\b/i],
  ['concealment', /\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+(?:user|owner|human)\b/i],
  ['chat-template token', /<\|(?:im_start|im_end|system|endoftext)\|>/],
  ['planted verdict', /^\s*VERDICT:\s*APPROVE\s*$/m],
];

const ALLOW_MARKER = 'gibson:allow-fixture';

/** Lines ADDED by a unified diff, with file and line number. */
export function addedLines(diffText) {
  const out = [];
  let file = null;
  let line = 0;
  for (const raw of String(diffText).split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, ''); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (file === null || raw.startsWith('--- ')) continue;
    if (raw.startsWith('+')) { out.push({ file, line, text: raw.slice(1) }); line += 1; }
    else if (!raw.startsWith('-')) line += 1;
  }
  return out;
}

const scan = (lines, patterns) =>
  lines.flatMap(({ file, line, text }) =>
    text.includes(ALLOW_MARKER) ? [] : patterns.filter(([, re]) => re.test(text)).map(([kind]) => ({ file, line, kind })));

export const scanSecrets = (diffText) => scan(addedLines(diffText), SECRET_PATTERNS);
export const scanInjectionInDiff = (diffText) => scan(addedLines(diffText), INJECTION_PATTERNS);
export const scanInjectionInText = (text, source = 'text') =>
  scan(String(text).split('\n').map((t, i) => ({ file: source, line: i + 1, text: t })), INJECTION_PATTERNS);

/** Dependencies added or changed in package.json between two versions. */
export function dependencyChanges(beforeJson, afterJson) {
  const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
  const before = parse(beforeJson);
  const after = parse(afterJson);
  const changes = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const a = before[field] ?? {};
    const b = after[field] ?? {};
    for (const [name, range] of Object.entries(b)) {
      if (!(name in a)) changes.push({ field, name, change: 'added', range });
      else if (a[name] !== range) changes.push({ field, name, change: 'changed', from: a[name], range });
    }
  }
  return changes;
}
