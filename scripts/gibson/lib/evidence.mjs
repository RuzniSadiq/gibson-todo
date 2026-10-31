// Review-evidence evaluation (Law 5 + G12), shared by CI and the pipeline.
// Pure function: given what GitHub says about a PR, may it merge?
//
//  * Only comments from the repo's own people count (OWNER/MEMBER/COLLABORATOR);
//    on a public repo anyone else can type "VERDICT: APPROVE".
//  * A review counts only for the exact head SHA it names. A push invalidates it.
//  * The reviewer vendor must differ from the builder vendor (E3, cross-vendor).
//  * Tier C additionally needs a FAN-OUT review and an owner approval bound to
//    the same head (G12 floor + the schema human gate).
import { finalVerdict } from './jsonx.mjs';
import { isMemoryOnly } from './tier.mjs';

export const REVIEW_MARKER = '<!-- gibson:review -->';
export const OWNER_MARKER = '<!-- gibson:owner-approval -->';
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const field = (body, name) => new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm').exec(body)?.[1] ?? null;

export function parseReview(comment) {
  if (!comment.body.includes(REVIEW_MARKER)) return null;
  return {
    sha: field(comment.body, 'Reviewed-SHA'),
    vendor: field(comment.body, 'Reviewer-Vendor'),
    mode: field(comment.body, 'Review-Mode'),
    verdict: finalVerdict(comment.body),
    at: comment.createdAt,
  };
}

/**
 * @param {{headSha: string, labels: string[], body: string, files: string[],
 *          comments: {body: string, authorAssociation: string, createdAt: string}[]}} pr
 * @returns {{state: 'success'|'failure', description: string, level?: string}}
 */
export function evaluateEvidence(pr, config) {
  const short = pr.headSha.slice(0, 7);
  if (isMemoryOnly(pr.files, config)) return { state: 'success', description: 'memory-only change (Law 4 exception)' };

  const builder = field(pr.body ?? '', 'Builder-Vendor');
  if (!builder) return { state: 'failure', description: 'PR body has no Builder-Vendor line — cannot prove independence' };

  const trusted = pr.comments.filter((c) => TRUSTED.has(c.authorAssociation));
  const reviews = trusted.map(parseReview).filter((r) => r && r.sha === pr.headSha).sort((a, b) => a.at.localeCompare(b.at));
  const latest = reviews.at(-1);
  if (!latest) return { state: 'failure', description: `no review of the exact head ${short} (stale reviews do not count)` };
  if (!latest.verdict) return { state: 'failure', description: 'latest review has no VERDICT final line (fail closed)' };
  if (latest.verdict !== 'APPROVE') return { state: 'failure', description: `latest review of ${short} requests changes` };
  if (!latest.vendor || latest.vendor === builder) {
    return { state: 'failure', description: `Law 5: reviewer vendor (${latest.vendor ?? 'unknown'}) must differ from builder (${builder})` };
  }

  const tierC = pr.labels.includes('tier:C');
  if (tierC) {
    if (latest.mode !== 'FAN-OUT') return { state: 'failure', description: 'Tier C needs a FAN-OUT + adversarial review' };
    const ownerOk = pr.comments.some((c) => c.authorAssociation === 'OWNER' && c.body.includes(OWNER_MARKER) && field(c.body, 'Owner-Approval') === pr.headSha);
    if (!ownerOk) return { state: 'failure', description: `Tier C: awaiting owner approval of ${short} (G12)` };
    return { state: 'success', description: `E3 ${latest.vendor} FAN-OUT approved + owner approved ${short}`, level: 'E4' };
  }
  return { state: 'success', description: `E3 cross-vendor review (${latest.vendor}) approved ${short}`, level: 'E3' };
}
