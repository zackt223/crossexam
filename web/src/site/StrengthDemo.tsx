import { useEffect, useMemo, useRef, useState } from 'react';
import { onFirstView } from './fx';
import { reducedMotion } from './glass';

type Fn = (total: number, member?: boolean) => number;

// The change an agent made, and the defects crossexam would plant in it.
// These really run: every mutant is executed against the tests you switch on.
const CODE = [
  { n: 1, text: 'export function shipping(total, member = false) {', changed: false },
  { n: 2, text: '  if (total >= 50 || member) return 0;', changed: true },
  { n: 3, text: '  return 4.99 + total * 0.02;', changed: true },
  { n: 4, text: '}', changed: false },
];

const original: Fn = (t, m = false) => (t >= 50 || m ? 0 : 4.99 + t * 0.02);

const MUTANTS: { id: string; line: number; op: string; from: string; to: string; why: string; fn: Fn }[] = [
  { id: 'm1', line: 2, op: 'boundary', from: '>=', to: '>', why: 'no test sits exactly on $50', fn: (t, m = false) => (t > 50 || m ? 0 : 4.99 + t * 0.02) },
  { id: 'm2', line: 2, op: 'logical', from: '||', to: '&&', why: 'free shipping is never tested on its own', fn: (t, m = false) => (t >= 50 && m ? 0 : 4.99 + t * 0.02) },
  { id: 'm3', line: 2, op: 'negate', from: 'if (', to: 'if (!(', why: '', fn: (t, m = false) => (!(t >= 50 || m) ? 0 : 4.99 + t * 0.02) },
  { id: 'm4', line: 3, op: 'arithmetic', from: '+', to: '-', why: '', fn: (t, m = false) => (t >= 50 || m ? 0 : 4.99 - t * 0.02) },
  { id: 'm5', line: 3, op: 'arithmetic', from: '*', to: '/', why: '', fn: (t, m = false) => (t >= 50 || m ? 0 : 4.99 + t / 0.02) },
];

const TESTS: { id: string; name: string; call: [number, boolean?]; expect: number; agent: boolean }[] = [
  { id: 't1', name: 'a $20 cart pays $5.39', call: [20], expect: 5.39, agent: true },
  { id: 't2', name: 'an $80 cart ships free', call: [80], expect: 0, agent: false },
  { id: 't3', name: 'members ship free', call: [20, true], expect: 0, agent: false },
  { id: 't4', name: 'exactly $50 ships free', call: [50], expect: 0, agent: false },
];

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// sanity: every test passes on the real code
for (const t of TESTS) if (!close(original(...t.call), t.expect)) throw new Error(`demo test ${t.id} fails on the original`);

type Status = 'idle' | 'running' | 'killed' | 'survived';

export function StrengthDemo() {
  const root = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(TESTS.map((t) => [t.id, t.agent])));
  const [status, setStatus] = useState<Record<string, Status>>(() => Object.fromEntries(MUTANTS.map((m) => [m.id, 'idle'])));
  const [focus, setFocus] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const timers = useRef<number[]>([]);

  // run every mutant against the switched-on tests
  const results = useMemo(() => {
    const active = TESTS.filter((t) => on[t.id]);
    return Object.fromEntries(
      MUTANTS.map((m) => {
        const killer = active.find((t) => !close(m.fn(...t.call), t.expect));
        return [m.id, { killed: !!killer, by: killer?.name ?? null }];
      }),
    );
  }, [on]);

  const play = (slow: boolean) => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (reducedMotion()) {
      setStatus(Object.fromEntries(MUTANTS.map((m) => [m.id, results[m.id].killed ? 'killed' : 'survived'])));
      return;
    }
    const gap = slow ? 420 : 70;
    MUTANTS.forEach((m, i) => {
      timers.current.push(
        window.setTimeout(() => {
          setStatus((s) => ({ ...s, [m.id]: 'running' }));
          if (slow) setFocus(m.id);
        }, i * gap),
        window.setTimeout(() => setStatus((s) => ({ ...s, [m.id]: results[m.id].killed ? 'killed' : 'survived' })), i * gap + (slow ? 340 : 160)),
      );
    });
    if (slow) timers.current.push(window.setTimeout(() => setFocus(MUTANTS.find((m) => !results[m.id].killed)?.id ?? null), MUTANTS.length * gap + 200));
  };

  useEffect(() => onFirstView(root.current, () => setStarted(true)), []);
  const first = useRef(true);
  useEffect(() => {
    if (!started) return;
    play(first.current);
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, results]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const done = MUTANTS.every((m) => status[m.id] === 'killed' || status[m.id] === 'survived');
  const killed = MUTANTS.filter((m) => status[m.id] === 'killed').length;
  const survived = MUTANTS.filter((m) => status[m.id] === 'survived').length;
  const score = killed + survived ? killed / (killed + survived) : 0;
  const rating = !done ? 'running' : score >= 0.8 ? 'strong' : score >= 0.6 ? 'moderate' : 'weak';
  const fm = MUTANTS.find((m) => m.id === focus) ?? null;
  const C = 2 * Math.PI * 34;

  return (
    <div className="strength glass" ref={root}>
      <div className="st-code">
        <div className="st-file">
          <span>cart/shipping.js</span>
          <span className="st-agent">changed by the agent</span>
        </div>
        <pre aria-label="the changed code">
          {CODE.map((l) => {
            const m = fm && fm.line === l.n ? fm : null;
            let body: React.ReactNode = l.text;
            if (m) {
              const i = l.text.indexOf(m.from);
              const end = m.op === 'negate' ? l.text.indexOf(') return') : -1;
              body =
                m.op === 'negate' ? (
                  <>
                    {l.text.slice(0, i)}
                    <ins>if (!(</ins>
                    {l.text.slice(i + 4, end)}
                    <ins>))</ins>
                    {l.text.slice(end + 1)}
                  </>
                ) : (
                  <>
                    {l.text.slice(0, i)}
                    <del>{m.from}</del>
                    <ins>{m.to}</ins>
                    {l.text.slice(i + m.from.length)}
                  </>
                );
            }
            return (
              <div key={l.n} className={`st-line${l.changed ? ' changed' : ''}${m ? ' mutated' : ''}`}>
                <span className="st-n">{l.n}</span>
                <span className="st-g">{l.changed ? '+' : ' '}</span>
                <code>{body}</code>
              </div>
            );
          })}
        </pre>
        <div className="st-file st-file2">
          <span>cart/shipping.test.js</span>
          <span className="st-agent">
            {TESTS.filter((t) => on[t.id]).length} test{TESTS.filter((t) => on[t.id]).length === 1 ? '' : 's'}
          </span>
        </div>
        <pre className="st-tests-code" aria-label="the tests that run">
          {TESTS.filter((t) => on[t.id]).map((t) => (
            <div key={t.id} className={`st-line${t.agent ? '' : ' added'}`}>
              <span className="st-n" />
              <span className="st-g">{t.agent ? ' ' : '+'}</span>
              <code>
                test(<span className="st-str">'{t.name}'</span>, () =&gt; expect(shipping({t.call.map(String).join(', ')})).toBe({t.expect}));
              </code>
            </div>
          ))}
        </pre>
        <div className="st-claim">
          <span className="st-v ok">✓ verified</span>
          <span>“added free shipping over $50 and for members. tests pass.”</span>
        </div>
      </div>

      <div className="st-side">
        <div className="st-score">
          <svg viewBox="0 0 80 80" className={`st-ring ${rating}`} aria-hidden="true">
            <circle cx="40" cy="40" r="34" className="st-ring-bg" />
            <circle cx="40" cy="40" r="34" className="st-ring-fg" style={{ strokeDasharray: C, strokeDashoffset: C * (1 - (done ? score : 0)) }} />
          </svg>
          <div>
            <div className="st-rating">{done ? `${rating} tests` : 'planting defects…'}</div>
            <div className="st-sub" aria-live="polite">
              {done ? `${killed} of ${MUTANTS.length} planted defects caught${survived ? `, ${survived} went unnoticed` : ''}` : 'running the tests against each one'}
            </div>
          </div>
        </div>

        <div className="st-h">mutants</div>
        <ul className="st-mutants">
          {MUTANTS.map((m) => {
            const s = status[m.id];
            return (
              <li key={m.id}>
                <button className={`st-m ${s}${focus === m.id ? ' on' : ''}`} onClick={() => setFocus(focus === m.id ? null : m.id)} onMouseEnter={() => setFocus(m.id)}>
                  <span className="st-op">{m.op}</span>
                  <code>
                    {m.from} → {m.to}
                  </code>
                  <span className="st-s">{s === 'running' ? <i className="st-spin" /> : s === 'killed' ? 'caught' : s === 'survived' ? 'missed' : ''}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {fm && status[fm.id] === 'survived' && fm.why && <p className="st-why">missed because {fm.why}.</p>}
        {fm && status[fm.id] === 'killed' && <p className="st-why ok">caught by “{results[fm.id].by}”.</p>}

        <div className="st-h">tests {TESTS.some((t) => !t.agent && on[t.id]) ? '' : '· the agent wrote one'}</div>
        <ul className="st-tests">
          {TESTS.map((t) => (
            <li key={t.id}>
              <label className="st-t">
                <input type="checkbox" className="g-switch" checked={on[t.id]} onChange={(e) => setOn((o) => ({ ...o, [t.id]: e.target.checked }))} />
                <span>{t.name}</span>
                {t.agent && <em>agent’s</em>}
              </label>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
