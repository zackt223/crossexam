import { useState } from 'react';
import { skyTexture } from './skytex';

// What 0.4 added: behavioural defects, the agent re-check loop, reliability by agent.

const DEFECTS: { cat: string; color: string; from: string; to: string; means: string }[] = [
  { cat: 'authorization', color: '#ff3b30', from: "if (!user.roles.includes('finance')) throw …", to: 'if (false) throw …', means: 'no test proves a caller without permission is turned away' },
  { cat: 'transactions', color: '#ff9f43', from: 'await tx.commit();', to: 'await tx.rollback();', means: 'nothing checks the work is actually committed' },
  { cat: 'retries', color: '#e0a41e', from: 'attempt < maxRetries', to: 'attempt < 1', means: 'nothing tests a first attempt that fails' },
  { cat: 'concurrency', color: '#8b6cff', from: 'await Promise.all(jobs)', to: 'await Promise.allSettled(jobs)', means: 'one failed job never fails the batch in a test' },
  { cat: 'boundaries', color: '#00aaee', from: 'items[items.length - 1]', to: 'items[items.length]', means: 'no test checks the last item' },
];

const LOOP = [
  { who: 'crossexam', t: '1 finding · high · authorization', d: 'skipping the finance check still passed every test. session cx-0da8d0a5ba' },
  { who: 'agent', t: 'adds a test: others are turned away', d: 'then calls reverify_findings with the session' },
  { who: 'crossexam', t: '✓ resolved on re-check 1', d: 'planted the same defect again; the new test failed, as it should' },
];

const AGENTS = [
  { a: 'agent a', held: 0.96, caught: 0.84, first: 0.82 },
  { a: 'agent b', held: 0.91, caught: 0.67, first: 0.64 },
  { a: 'agent c', held: 0.88, caught: 0.71, first: 0.55 },
];

export function WhatsNew() {
  const [d, setD] = useState(0);
  const [step, setStep] = useState(LOOP.length);
  const tex = skyTexture();
  const x = DEFECTS[d];
  return (
    <div className="wn">
      <div className="wn-card wn-defects">
        <span className="wn-k">smarter mutations</span>
        <h3>defects that look like real bugs</h3>
        <div className="wn-cats" role="tablist" aria-label="defect categories">
          {DEFECTS.map((c, i) => (
            <button key={c.cat} role="tab" aria-selected={d === i} className={d === i ? 'on' : ''} onClick={() => setD(i)} style={{ ['--c' as string]: c.color }}>
              <i />
              {c.cat}
            </button>
          ))}
        </div>
        <pre className="wn-diff">
          <span className="del">- {x.from}</span>
          {'\n'}
          <span className="add">+ {x.to}</span>
        </pre>
        <p className="wn-means">if your tests still pass: {x.means}.</p>
      </div>

      <div className="wn-card wn-loop" style={{ backgroundImage: `url(${tex})` }}>
        <span className="wn-k light">agent-driven verification</span>
        <h3 className="light">agents fix it. crossexam re-checks it.</h3>
        <div className="wn-steps">
          {LOOP.slice(0, step).map((s, i) => (
            <div key={i} className={`wn-step ${s.who}`}>
              <b>{s.t}</b>
              <span>{s.d}</span>
            </div>
          ))}
        </div>
        <button className="wn-replay" onClick={() => (setStep(0), LOOP.forEach((_, i) => setTimeout(() => setStep(i + 1), 450 * (i + 1))))}>
          replay
        </button>
      </div>

      <div className="wn-card wn-rel">
        <span className="wn-k">reliability intelligence</span>
        <h3>which agent to trust, from evidence</h3>
        <div className="wn-table">
          <div className="wn-row head">
            <span />
            <span>claims held</span>
            <span>tests caught</span>
            <span>fixed 1st try</span>
          </div>
          {AGENTS.map((r) => (
            <div key={r.a} className="wn-row">
              <b>{r.a}</b>
              {[r.held, r.caught, r.first].map((v, i) => (
                <span key={i} className="wn-m">
                  <i style={{ width: `${v * 100}%` }} className={v >= 0.8 ? 'g' : v >= 0.6 ? 'm' : 'b'} />
                  <em>{Math.round(v * 100)}%</em>
                </span>
              ))}
            </div>
          ))}
        </div>
        <p className="wn-means">three measures, never blended. example numbers; yours come from your own runs.</p>
      </div>
    </div>
  );
}
