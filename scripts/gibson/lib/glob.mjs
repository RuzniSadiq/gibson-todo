// Minimal glob matcher: `**` crosses directories, `*` and `?` do not.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const matches = (path, glob) => globToRegExp(glob).test(path);
export const matchesAny = (path, globs) => globs.some((g) => matches(path, g));

/**
 * Conservative overlap test for two scope globs (claims, Law 2). Fails closed:
 * when it cannot prove the scopes are disjoint, it reports overlap.
 */
export function scopesOverlap(a, b) {
  const literal = (g) => g.split(/[*?]/)[0];
  const la = literal(a);
  const lb = literal(b);
  if (!/[*?]/.test(a) && !/[*?]/.test(b)) return a === b;
  if (!/[*?]/.test(a)) return matches(a, b);
  if (!/[*?]/.test(b)) return matches(b, a);
  return la.startsWith(lb) || lb.startsWith(la);
}
