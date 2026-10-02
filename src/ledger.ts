/**
 * Claim ledger for debates: every claim, who made it, its evidence and citation checks, and each
 * peer's latest stance. Convergence is decided here from the stances, not from a model's say-so.
 */
import { checkEvidence, isFailure, type CitationResult } from './citations.ts';
import { MAX_CLAIMS } from './prompts.ts';
import type { DebateTurn, Evidence } from './schemas.ts';

/** Claims beyond this many per seat are not recorded: peers cannot take a stance on dozens. */
export const CLAIM_HARD_CAP = MAX_CLAIMS + 4;

export type ClaimStatus = 'agreed' | 'partial' | 'disputed' | 'unaddressed' | 'withdrawn';

export interface Stance {
  stance: string;
  reason: string;
  round: number;
}

export interface LedgerClaim {
  gid: string;
  owner: string;
  id: string;
  text: string;
  kind: string;
  confidence: number;
  evidence: Evidence[];
  citations: CitationResult[];
  introduced: number;
  lastSeen: number;
  withdrawn: boolean;
  stances: Record<string, Stance>;
  /** Stance history, for "changed minds". */
  history: { seat: string; round: number; stance: string }[];
}

export interface RoundStats {
  round: number;
  claims: number;
  agreed: number;
  partial: number;
  disputed: number;
  unaddressed: number;
  withdrawn: number;
  citationsChecked: number;
  citationsFailed: number;
  verdicts: Record<string, string>;
}

export class ClaimLedger {
  readonly claims = new Map<string, LedgerClaim>();
  readonly verdicts: Record<string, string> = {};
  readonly rounds: RoundStats[] = [];
  readonly concessions: { seat: string; round: number; text: string }[] = [];
  readonly seats: string[];
  readonly cwd: string;

  constructor(seats: string[], cwd: string) {
    this.seats = seats;
    this.cwd = cwd;
  }

  /** Normalize a peer claim reference ("B:c2", "B c2", "c2" when unambiguous) to a global id. */
  resolveRef(ref: string, from: string): string | undefined {
    const m = /^\s*([A-Z])\s*[:.\- ]\s*([A-Za-z0-9_-]+)\s*$/.exec(ref);
    if (m) {
      const gid = `${m[1]}:${m[2]}`;
      return this.claims.has(gid) ? gid : undefined;
    }
    const bare = ref.trim();
    const hits = [...this.claims.values()].filter((c) => c.id === bare && c.owner !== from);
    return hits.length === 1 ? hits[0].gid : undefined;
  }

  /** Record a seat's turn; returns how many claims were over the cap and not recorded. */
  update(seat: string, round: number, t: DebateTurn): number {
    const seen = new Set<string>();
    const kept = t.claims.slice(0, CLAIM_HARD_CAP);
    for (const c of kept) {
      const gid = `${seat}:${c.id}`;
      seen.add(gid);
      const prev = this.claims.get(gid);
      const changed = !prev || prev.text !== c.text || JSON.stringify(prev.evidence) !== JSON.stringify(c.evidence);
      const claim: LedgerClaim = {
        gid,
        owner: seat,
        id: c.id,
        text: c.text,
        kind: c.kind,
        confidence: c.confidence,
        evidence: c.evidence,
        citations: changed || !prev ? c.evidence.map((e) => checkEvidence(e, this.cwd)) : prev.citations,
        introduced: prev?.introduced ?? round,
        lastSeen: round,
        withdrawn: false,
        // A materially changed claim needs fresh stances.
        stances: changed && prev ? {} : prev?.stances ?? {},
        history: prev?.history ?? [],
      };
      this.claims.set(gid, claim);
    }
    for (const c of this.claims.values()) {
      if (c.owner === seat && !seen.has(c.gid) && round > c.introduced) c.withdrawn = true;
    }
    for (const s of t.stances) {
      const gid = this.resolveRef(s.claim, seat);
      if (!gid) continue;
      const claim = this.claims.get(gid)!;
      if (claim.owner === seat) continue;
      claim.stances[seat] = { stance: s.stance, reason: s.reason, round };
      claim.history.push({ seat, round, stance: s.stance });
    }
    for (const text of t.concessions) this.concessions.push({ seat, round, text });
    this.verdicts[seat] = t.verdict;
    return t.claims.length - kept.length;
  }

  status(c: LedgerClaim): ClaimStatus {
    if (c.withdrawn) return 'withdrawn';
    const others = this.seats.filter((s) => s !== c.owner);
    const st = others.map((s) => c.stances[s]?.stance);
    if (st.includes('disagree')) return 'disputed';
    if (st.some((x) => x === undefined || x === 'unsure')) return 'unaddressed';
    if (st.includes('partial')) return 'partial';
    return 'agreed';
  }

  active(): LedgerClaim[] {
    return [...this.claims.values()].filter((c) => !c.withdrawn);
  }

  closeRound(round: number): RoundStats {
    const active = this.active();
    const count = (s: ClaimStatus) => active.filter((c) => this.status(c) === s).length;
    const cites = active.flatMap((c) => c.citations).filter((r) => r.status !== 'not_checked');
    const stats: RoundStats = {
      round,
      claims: active.length,
      agreed: count('agreed'),
      partial: count('partial'),
      disputed: count('disputed'),
      unaddressed: count('unaddressed'),
      withdrawn: this.claims.size - active.length,
      citationsChecked: cites.length,
      citationsFailed: cites.filter(isFailure).length,
      verdicts: { ...this.verdicts },
    };
    this.rounds.push(stats);
    return stats;
  }

  /**
   * Converged = every seat's verdict is agree AND every active claim is agreed by all other seats.
   * Verdicts alone are not enough: models can each "agree" with the other's previous position and
   * cross over, which only shows up as claims the other side never addressed.
   */
  converged(activeSeats: string[]): boolean {
    return this.verdictsAgree(activeSeats) && this.active().every((c) => !activeSeats.includes(c.owner) || this.status(c) === 'agreed');
  }

  verdictsAgree(activeSeats: string[]): boolean {
    return activeSeats.every((s) => this.verdicts[s] === 'agree');
  }

  openClaims(): LedgerClaim[] {
    return this.active().filter((c) => this.status(c) !== 'agreed');
  }

  /** Did anyone move this round (a stance or verdict change)? A stalled debate can stop early. */
  movedIn(round: number): boolean {
    return [...this.claims.values()].some((c) => c.history.some((h) => h.round === round && this.changedAt(c, h))) ||
      this.concessions.some((x) => x.round === round);
  }

  private changedAt(c: LedgerClaim, h: { seat: string; round: number; stance: string }): boolean {
    const prior = c.history.filter((x) => x.seat === h.seat && x.round < h.round).pop();
    return !prior || prior.stance !== h.stance;
  }

  /** Stance flips across the debate, e.g. B went disagree -> agree on A:c2. */
  changedMinds(): { seat: string; claim: string; from: string; to: string; round: number }[] {
    const out: { seat: string; claim: string; from: string; to: string; round: number }[] = [];
    for (const c of this.claims.values()) {
      const bySeat = new Map<string, { round: number; stance: string }[]>();
      for (const h of c.history) (bySeat.get(h.seat) ?? bySeat.set(h.seat, []).get(h.seat)!).push(h);
      for (const [seat, hs] of bySeat) {
        for (let i = 1; i < hs.length; i++) {
          if (hs[i].stance !== hs[i - 1].stance) out.push({ seat, claim: c.gid, from: hs[i - 1].stance, to: hs[i].stance, round: hs[i].round });
        }
      }
    }
    return out;
  }

  toJSON(): unknown {
    return {
      seats: this.seats,
      verdicts: this.verdicts,
      rounds: this.rounds,
      concessions: this.concessions,
      claims: [...this.claims.values()].map((c) => ({ ...c, status: this.status(c) })),
    };
  }
}
