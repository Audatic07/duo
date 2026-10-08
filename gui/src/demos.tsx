/**
 * Animated "how it works" scenes, one per mode. A small step clock drives every element of a scene
 * together (CSS transitions do the motion), so a scene always resets cleanly. Scenes pause when
 * they are off screen and stay on their final frame when the user prefers reduced motion.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { EngineMark, Icon } from './ui.tsx';

export type ModeId = 'chat' | 'split' | 'pair' | 'debate' | 'review' | 'council' | 'ask';

export interface ModeInfo {
  id: ModeId;
  label: string;
  icon: string;
  tagline: string;
  steps: string[];
  /** Run protocol behind the mode (chat modes have none). */
  protocol?: 'debate' | 'review' | 'council' | 'ask' | 'pair';
  needsProject?: boolean;
}

export const MODES: Record<ModeId, ModeInfo> = {
  chat: {
    id: 'chat',
    label: 'Chat',
    icon: 'chat',
    tagline: 'Claude Code or Codex in your project, with every command, edit and thought in view.',
    steps: ['You ask', 'It thinks', 'It runs commands', 'It edits files', 'It checks its work', 'You get the answer'],
  },
  split: {
    id: 'split',
    label: 'Side by side',
    icon: 'split',
    tagline: 'One message, two answers. Hand either answer to the other for a critical review.',
    steps: ['One message goes to both', 'Claude and Codex answer independently', 'Send one answer to the other', 'The other reviews it'],
  },
  pair: {
    id: 'pair',
    label: 'Pair',
    icon: 'pair',
    protocol: 'pair',
    needsProject: true,
    tagline: 'One model writes the code, the other reviews it, in cycles until both agree the task is done.',
    steps: ['The writer implements the task in its own worktree', 'duo runs your check command', 'The reviewer verifies the diff and files findings', 'The writer fixes or disputes each finding', 'Both agree: you apply the result'],
  },
  debate: {
    id: 'debate',
    label: 'Debate',
    icon: 'debate',
    protocol: 'debate',
    tagline: 'Blind answers, cross-examination, then a final ledger review with agreement or disagreement on every claim.',
    steps: ['Both answer blind', 'Claims go on the ledger', 'Each takes a stance on the other’s claims', 'Someone concedes', 'Final ledger review: every claim gets a decision'],
  },
  review: {
    id: 'review',
    label: 'Review',
    icon: 'review',
    protocol: 'review',
    needsProject: true,
    tagline: 'Independent code reviews, cross-checked; issues found by both are the strongest signal.',
    steps: ['Each reviewer reads the diff alone', 'Findings land on exact lines', 'They confirm or reject each other’s findings', 'Merged: found by both, confirmed, rejected'],
  },
  council: {
    id: 'council',
    label: 'Council',
    icon: 'council',
    protocol: 'council',
    tagline: 'Several answers, ranked anonymously by peers who never see their own; a chair writes the synthesis.',
    steps: ['Every seat answers', 'Answers are anonymized', 'Peers rank the others', 'Scores combine', 'The chair writes the synthesis'],
  },
  ask: {
    id: 'ask',
    label: 'Ask',
    icon: 'ask',
    protocol: 'ask',
    tagline: 'The same question to several models at once, answers side by side, fully traced.',
    steps: ['One question', 'Every seat answers in parallel', 'Compare side by side', 'Optional: a chair compares them'],
  },
};

export const MODE_ORDER: ModeId[] = ['chat', 'split', 'pair', 'debate', 'review', 'council', 'ask'];

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Step clock: advances through `durations` (ms per step) and loops; pauses off screen. */
function useSteps(durations: number[], ref: { current: HTMLElement | null }, playing = true): number {
  const last = durations.length - 1;
  const [step, setStep] = useState(() => (reducedMotion() ? last : 0));
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!playing || !visible || reducedMotion()) return;
    const t = setTimeout(() => setStep((s) => (s >= last ? 0 : s + 1)), durations[step]);
    return () => clearTimeout(t);
  }, [step, playing, visible]);
  return step;
}

const on = (cond: boolean) => (cond ? ' on' : '');

function Lines({ n, widths, cls = '' }: { n: number; widths?: number[]; cls?: string }) {
  const w = widths ?? [92, 78, 85, 60, 70, 88];
  return <>{Array.from({ length: n }, (_, i) => <span class={`d-line ${cls}`} style={{ width: `${w[i % w.length]}%` }} />)}</>;
}

function Captioned({ size, caption, steps, idx, children }: { size: 'card' | 'large'; caption?: boolean; steps: string[]; idx: number; children: ComponentChildren }) {
  return (
    <div class={`demo demo-${size}`}>
      <div class="demo-stage">{children}</div>
      {caption && (
        <div class="demo-caption" aria-live="polite">
          <span class="demo-dots">{steps.map((_, i) => <i class={i === idx ? 'on' : i < idx ? 'past' : ''} />)}</span>
          <span class="demo-text" key={idx}>{steps[idx]}</span>
        </div>
      )}
    </div>
  );
}

// ── scenes ───────────────────────────────────────────────────────────────

function ChatDemo({ size, caption }: { size: 'card' | 'large'; caption?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useSteps([900, 900, 1100, 1200, 1100, 1300, 2400], ref);
  const idx = [0, 1, 2, 3, 4, 5, 5][s];
  return (
    <div ref={ref}>
      <Captioned size={size} caption={caption} steps={MODES.chat.steps} idx={idx}>
        <div class="d-chat">
          <div class={`d-bubble user${on(s >= 0)}`}>Fix the failing auth test</div>
          <div class={`d-row think${on(s >= 1)}`}><Icon name="spark" size={11} /> Thinking</div>
          <div class={`d-row tool${on(s >= 2)}`}><Icon name="terminal" size={11} /><span class="mono">npm test</span><span class={`d-badge ${s >= 4 ? 'good' : 'bad'}`}>{s >= 4 ? 'passed' : '1 failed'}</span></div>
          <div class={`d-row tool${on(s >= 3)}`}><Icon name="edit" size={11} /><span class="mono">auth.ts</span><span class="d-diff"><i class="del" /><i class="add" /></span></div>
          <div class={`d-answer${on(s >= 5)}`}><EngineMark engine="claude" size={16} /><span class="d-lines"><Lines n={2} widths={[90, 62]} /></span></div>
        </div>
      </Captioned>
    </div>
  );
}

function SplitDemo({ size, caption }: { size: 'card' | 'large'; caption?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useSteps([900, 1300, 1300, 1300, 2400], ref);
  const idx = [0, 1, 2, 3, 3][s];
  return (
    <div ref={ref}>
      <Captioned size={size} caption={caption} steps={MODES.split.steps} idx={idx}>
        <div class="d-split">
          <div class={`d-bubble user center${on(s >= 0)}`}>Why is the build slow?</div>
          <div class="d-panes">
            <div class="d-pane claude">
              <div class="d-pane-head"><EngineMark engine="claude" size={14} /> Claude</div>
              <span class={`d-fill${on(s >= 1)}`}><Lines n={3} widths={[88, 70, 80]} /></span>
              <div class={`d-review${on(s >= 3)}`}><Icon name="review" size={11} /> 2 things to add</div>
            </div>
            <div class={`d-handoff${on(s >= 2)}`}><Icon name="forward" size={14} /></div>
            <div class="d-pane codex">
              <div class="d-pane-head"><EngineMark engine="codex" size={14} /> Codex</div>
              <span class={`d-fill${on(s >= 1)}`}><Lines n={3} widths={[76, 92, 64]} /></span>
            </div>
          </div>
        </div>
      </Captioned>
    </div>
  );
}

function PairDemo({ size, caption }: { size: 'card' | 'large'; caption?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useSteps([1300, 1000, 1400, 1300, 1000, 1200, 2600], ref);
  const idx = [0, 1, 2, 3, 1, 2, 4][s];
  const cycle = s >= 3 ? 2 : 1;
  return (
    <div ref={ref}>
      <Captioned size={size} caption={caption} steps={MODES.pair.steps} idx={idx}>
        <div class="d-pair">
          <div class="d-col">
            <div class="d-role"><EngineMark engine="codex" size={14} /> Writer</div>
            <div class="d-code">
              <i class={`ln${on(s >= 0)}`} style={{ width: '70%' }} />
              <i class={`ln add${on(s >= 0)}`} style={{ width: '84%' }} />
              <i class={`ln add${on(s >= 0)}`} style={{ width: '58%' }} />
              <i class={`ln add fix${on(s >= 3)}`} style={{ width: '66%' }} />
              <i class={`ln${on(s >= 0)}`} style={{ width: '40%' }} />
            </div>
            <div class={`d-check${on(s >= 1)} ${s >= 4 ? 'good' : 'bad'}`}><Icon name={s >= 4 ? 'check' : 'x'} size={11} /> npm test</div>
          </div>
          <div class="d-mid">
            <span class={`d-cycle${on(true)}`}>cycle {cycle}</span>
            <span class={`d-arrow right${on(s >= 2 && s < 3 || s >= 5)}`}><Icon name="forward" size={13} /></span>
            <span class={`d-arrow left${on(s >= 3 && s < 5)}`}><Icon name="forward" size={13} /></span>
          </div>
          <div class="d-col">
            <div class="d-role"><EngineMark engine="claude" size={14} /> Reviewer</div>
            <div class={`d-finding${on(s >= 2 && s < 5)}`}><span class="sev P1">P1</span> missing null check</div>
            <div class={`d-finding resolved${on(s >= 5)}`}><Icon name="check" size={11} /> f1 resolved</div>
            <div class={`d-verdict${on(s >= 5)}`}>approve</div>
          </div>
          <div class={`d-done${on(s >= 6)}`}><Icon name="check-circle" size={14} /> Both agree: done</div>
        </div>
      </Captioned>
    </div>
  );
}

function DebateDemo({ size, caption }: { size: 'card' | 'large'; caption?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useSteps([1200, 1200, 1300, 1300, 2600], ref);
  const stance = (agreeAt: number, disagreeAt: number) => (s >= agreeAt ? 'agree' : s >= disagreeAt ? 'disagree' : '');
  return (
    <div ref={ref}>
      <Captioned size={size} caption={caption} steps={MODES.debate.steps} idx={s}>
        <div class="d-debate">
          <div class="d-side">
            <EngineMark engine="codex" size={18} />
            <div class={`d-card${on(s >= 0)}`}><Lines n={2} widths={[86, 60]} /></div>
          </div>
          <div class="d-ledger">
            {[['A:c1', 2, 99], ['A:c2', 3, 2], ['B:c1', 2, 99]].map(([id, a, d]) => (
              <div class={`d-claim${on(s >= 1)}`}>
                <span class="mono">{id}</span>
                <span class={`d-stance ${stance(a as number, d as number)}`}>{stance(a as number, d as number) || '…'}</span>
              </div>
            ))}
            <div class={`d-concede${on(s >= 3)}`}>B concedes A:c2</div>
          </div>
          <div class="d-side">
            <EngineMark engine="claude" size={18} />
            <div class={`d-card${on(s >= 0)}`}><Lines n={2} widths={[70, 90]} /></div>
          </div>
          <div class={`d-done${on(s >= 4)}`}><Icon name="check-circle" size={14} /> Final ledger review: all agree</div>
        </div>
      </Captioned>
    </div>
  );
}

function ReviewDemo({ size, caption }: { size: 'card' | 'large'; caption?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useSteps([1100, 1300, 1400, 2600], ref);
  return (
    <div ref={ref}>
      <Captioned size={size} caption={caption} steps={MODES.review.steps} idx={s}>
        <div class="d-review-scene">
          <div class="d-diffbox">
            {[72, 64, 88, 50, 76, 60].map((w, i) => <i class={`ln ${i === 1 || i === 2 ? 'add' : i === 4 ? 'del' : ''} on`} style={{ width: `${w}%` }} />)}
            <span class={`d-pin a${on(s >= 1)}`} style={{ top: '22%' }}>A</span>
            <span class={`d-pin b${on(s >= 1)}`} style={{ top: '22%', left: '88%' }}>B</span>
            <span class={`d-pin b${on(s >= 1)}`} style={{ top: '70%', left: '88%' }}>B</span>
          </div>
          <div class="d-merged">
            <div class={`d-merge-row${on(s >= 2)}`}><span class="sev P1">P1</span> found by both <span class="d-chip good">✓✓</span></div>
            <div class={`d-merge-row${on(s >= 2)}`}><span class="sev P2">P2</span> confirmed by A <span class="d-chip good">✓</span></div>
            <div class={`d-merge-row muted${on(s >= 3)}`}><span class="sev P3">P3</span> rejected <span class="d-chip bad">✗</span></div>
          </div>
        </div>
      </Captioned>
    </div>
  );
}

function CouncilDemo({ size, caption }: { size: 'card' | 'large'; caption?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useSteps([1100, 1100, 1300, 1200, 2600], ref);
  const scores = [0.92, 0.66, 0.4, 0.18];
  return (
    <div ref={ref}>
      <Captioned size={size} caption={caption} steps={MODES.council.steps} idx={s}>
        <div class="d-council">
          <div class="d-answers">
            {['R1', 'R2', 'R3', 'R4'].map((r, i) => (
              <div class={`d-answer-card${on(s >= 0)}`} style={{ transitionDelay: `${i * 90}ms` }}>
                <span class={`d-label${on(s >= 1)}`}>{r}</span>
                <span class="d-bar"><span class={`d-bar-fill${on(s >= 3)}`} style={{ '--w': `${scores[i] * 100}%` } as Record<string, string>} /></span>
              </div>
            ))}
          </div>
          <div class={`d-rankers${on(s >= 2)}`}>{['A', 'B', 'C', 'D'].map((x) => <span class="d-voter">{x}</span>)}</div>
          <div class={`d-chair${on(s >= 4)}`}><Icon name="spark" size={12} /> Chair synthesis</div>
        </div>
      </Captioned>
    </div>
  );
}

function AskDemo({ size, caption }: { size: 'card' | 'large'; caption?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const s = useSteps([1000, 1400, 1300, 2600], ref);
  return (
    <div ref={ref}>
      <Captioned size={size} caption={caption} steps={MODES.ask.steps} idx={s}>
        <div class="d-ask">
          <div class={`d-bubble user center${on(s >= 0)}`}>Which queue should we use?</div>
          <div class="d-fan">
            {(['codex', 'claude', 'codex'] as const).map((e, i) => (
              <div class={`d-seat${on(s >= 1)}`} style={{ transitionDelay: `${i * 120}ms` }}>
                <EngineMark engine={e} size={14} />
                <span class={`d-fill${on(s >= 1)}`}><Lines n={2} widths={[80 - i * 8, 60 + i * 10]} /></span>
              </div>
            ))}
          </div>
          <div class={`d-chair${on(s >= 3)}`}><Icon name="spark" size={12} /> Chair compares</div>
        </div>
      </Captioned>
    </div>
  );
}

const SCENES: Record<ModeId, (p: { size: 'card' | 'large'; caption?: boolean }) => preact.JSX.Element> = {
  chat: ChatDemo,
  split: SplitDemo,
  pair: PairDemo,
  debate: DebateDemo,
  review: ReviewDemo,
  council: CouncilDemo,
  ask: AskDemo,
};

export function ModeDemo({ mode, size = 'card', caption }: { mode: ModeId; size?: 'card' | 'large'; caption?: boolean }) {
  const Scene = SCENES[mode];
  return <Scene size={size} caption={caption} />;
}
