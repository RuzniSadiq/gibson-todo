/**
 * A lane stops for one of three reasons, and only these:
 *   blocked        — a bounded loop ran out (gate, review cap, CI). Not a human
 *                    gate: reported verbatim, the run moves on to other work.
 *   awaiting-owner — a human gate from AGENTS.md (G1–G16) triggered.
 *   halt           — kill switch or G15/G16: stop the whole fleet.
 */
export class Park extends Error {
  constructor(kind, reason, gate = null) {
    super(reason);
    this.name = 'Park';
    this.kind = kind;
    this.gate = gate;
  }
}
