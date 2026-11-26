import { useEffect, useState } from 'react';
import { LogoMark } from '../components/Logo';
import { reducedMotion } from './glass';
import { Mosaic } from './Mosaic';
import { skyTexture } from './skytex';
import { LATEST } from './releases';

const LINES = [
  'hey. i’m crossexam.',
  'i went through everything your agents said they finished this week. three claims didn’t hold up, and one of them is a test run that never happened.',
  'i won’t change anything on my own. pick one and i’ll show you the exact command that disagrees.',
];

/** The hero: crossexam talking on the left, the mark assembling on the right. */
export function SlateHero({ cta }: { cta: React.ReactNode }) {
  const [step, setStep] = useState(0);
  const [shown, setShown] = useState(false);
  const [secs, setSecs] = useState(12);
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (reducedMotion()) {
      setStep(LINES.length + 1);
      return;
    }
    const ts = [450, 1500, 2900, 3800].map((d, i) => setTimeout(() => setStep(i + 1), d));
    return () => ts.forEach(clearTimeout);
  }, []);
  useEffect(() => {
    if (stopped) return;
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [stopped]);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return (
    <section className="sl-hero" id="top">
      <div className="sl-sky" style={{ backgroundImage: `url(${skyTexture()})` }}>
        <div className="sl-chat">
          {LINES.map((l, i) => (
            <div key={i} className={`sl-row${step > i ? ' in' : ''}`}>
              {i === 0 ? (
                <span className="sl-av">
                  <LogoMark size={30} />
                </span>
              ) : (
                <span className="sl-av ghost" />
              )}
              <p className="sl-bubble">{l}</p>
            </div>
          ))}
          {shown && (
            <div className="sl-row in">
              <span className="sl-av ghost" />
              <div className="sl-bubble ev">
                <span className="sl-v">✗ contradicted</span>
                <p>“all 214 tests pass.”</p>
                <code>
                  <span className="p">$</span> pnpm test
                </code>
                <code className="bad">Tests: 1 failed, 213 passed</code>
              </div>
            </div>
          )}
          <div className={`sl-you${step > 3 ? ' in' : ''}`}>
            <button className="sl-pill" onClick={() => setShown(true)} disabled={shown}>
              {shown ? 'show me the next one' : 'show me the first one'}
            </button>
          </div>
          <div className={`sl-ctl${step > 3 ? ' in' : ''}`}>
            <span className="sl-ctl-ic" aria-hidden="true">
              <i />
              <i />
            </span>
            <span>{stopped ? 'stopped' : 'checking'}</span>
            <span className="sl-dot" aria-hidden="true" />
            <span className="mono">
              {mm}:{ss}
            </span>
            <button className="sl-end" onClick={() => setStopped(true)} disabled={stopped}>
              × stop
            </button>
          </div>
        </div>
      </div>
      <div className="sl-paper">
        <a className="rel-pill" href="#new">
          <b>new</b> v{LATEST.version} · {LATEST.title.toLowerCase()} <span aria-hidden="true">→</span>
        </a>
        <h1>
          your agents say done.
          <br />
          <span>we check.</span>
        </h1>
        <div className="sl-mark">
          <Mosaic scale={1} />
        </div>
        <div className="sl-foot">
          <p>crossexam pulls the evidence together and tells you which run each verdict came from. any agent, on your machine, free.</p>
          {cta}
        </div>
      </div>
    </section>
  );
}
