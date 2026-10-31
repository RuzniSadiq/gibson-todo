import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../gibson/lib/config.mjs';
import { evaluateEvidence, OWNER_MARKER, REVIEW_MARKER } from '../gibson/lib/evidence.mjs';

const config = loadConfig();
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ME = config.reviewEvidence.reviewerLogins[0];
const review = ({ sha = HEAD, vendor = 'codex', mode = 'SOLO', verdict = 'APPROVE', who = 'OWNER', author = ME, at = '2026-11-01T10:00:00Z' } = {}) => ({
  authorAssociation: who, author, createdAt: at,
  body: `${REVIEW_MARKER}\n## review\n\nReviewed-SHA: ${sha}\nReviewer-Vendor: ${vendor}\nReview-Mode: ${mode}\n\nfindings…\n\nVERDICT: ${verdict}`,
});
const owner = (sha = HEAD, who = 'OWNER', author = config.reviewEvidence.ownerLogins[0]) => ({ authorAssociation: who, author, createdAt: '2026-11-01T11:00:00Z', body: `${OWNER_MARKER}\nOwner-Approval: ${sha}\n` });
const pr = (over = {}) => ({ headSha: HEAD, labels: ['tier:B'], body: 'Closes #3\nBuilder-Vendor: claude', files: ['src/cli/x.ts'], comments: [], ...over });
const state = (p) => evaluateEvidence(p, config).state;

describe('review evidence', () => {
  it('[AC-1.7] accepts a cross-vendor APPROVE bound to the exact head', () => {
    const result = evaluateEvidence(pr({ comments: [review()] }), config);
    assert.equal(result.state, 'success');
    assert.match(result.description, /cross-vendor review \(codex/);
    assert.equal(result.level, 'E3');
  });

  it('[AC-1.7] rejects stale reviews, same-vendor reviews and missing verdicts', () => {
    assert.equal(state(pr({ comments: [review({ sha: OLD })] })), 'failure', 'review of an older head');
    assert.equal(state(pr({ comments: [review({ vendor: 'claude' })] })), 'failure', 'Law 5: builder reviewed itself');
    assert.equal(state(pr({ comments: [{ ...review(), body: review().body.replace(/VERDICT: APPROVE$/, 'looks fine') }] })), 'failure');
    assert.equal(state(pr({ body: 'Closes #3', comments: [review()] })), 'failure', 'no Builder-Vendor => cannot prove independence');
    assert.equal(state(pr()), 'failure', 'no review at all');
  });

  it('[AC-1.7] ignores evidence typed by strangers on a public repo', () => {
    assert.equal(state(pr({ comments: [review({ who: 'NONE' })] })), 'failure');
    assert.equal(state(pr({ comments: [review({ who: 'CONTRIBUTOR' })] })), 'failure');
  });

  it('[AC-1.7] counts only reviews posted by a configured reviewer identity', () => {
    // A trusted collaborator typing "Reviewer-Vendor: codex" is still not the reviewer.
    assert.equal(state(pr({ comments: [review({ who: 'COLLABORATOR', author: 'some-collaborator' })] })), 'failure');
    const c = { labels: ['tier:C'] };
    assert.equal(state(pr({ ...c, comments: [review({ mode: 'FAN-OUT' }), owner(HEAD, 'OWNER', 'not-the-owner')] })), 'failure');
  });

  it('[AC-1.7] the latest review of the head wins', () => {
    const approveThenReject = [review({ at: '2026-11-01T10:00:00Z' }), review({ verdict: 'REQUEST_CHANGES', at: '2026-11-01T10:05:00Z' })];
    assert.equal(state(pr({ comments: approveThenReject })), 'failure');
    assert.equal(state(pr({ comments: [...approveThenReject, review({ at: '2026-11-01T10:09:00Z' })] })), 'success');
  });

  it('[AC-1.7] Tier C needs FAN-OUT review plus owner approval of the same head', () => {
    const c = { labels: ['tier:C'] };
    assert.equal(state(pr({ ...c, comments: [review()] })), 'failure', 'SOLO is not enough');
    assert.match(evaluateEvidence(pr({ ...c, comments: [review({ mode: 'FAN-OUT' })] }), config).description, /awaiting owner/);
    assert.equal(state(pr({ ...c, comments: [review({ mode: 'FAN-OUT' }), owner(OLD)] })), 'failure', 'approval of an older head');
    assert.equal(state(pr({ ...c, comments: [review({ mode: 'FAN-OUT' }), owner(HEAD, 'COLLABORATOR')] })), 'failure', 'only the owner approves Tier C');
    assert.equal(state(pr({ ...c, comments: [review({ mode: 'FAN-OUT' }), owner()] })), 'success');
  });

  it('[AC-1.7] memory-only PRs skip the review gate (Law 4 exception)', () => {
    assert.equal(state(pr({ files: ['MEMORY.md'], body: '' })), 'success');
  });
});
