import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../db/client';
import type { AddScanInput } from '../db/repo';
import { chooseFinish } from '../lib/cards';
import type { Candidate, Finish, Printing, Scan, ScanStatus, Session } from '../lib/types';
import { FINISH_LABEL } from '../lib/types';
import { CameraError, captureCard, cardJpeg, guideRect, openCamera, setTorch, stopCamera, torchSupported } from '../scan/camera';
import { warmUpOcr, browserOcr } from '../scan/ocr';
import { prepareCrops, readCard } from '../scan/pipeline';
import { Sheet, errorText } from './common';
import { feedback } from './feedback';

/**
 * Below this the frame is essentially blank (lens covered, no card): nothing is saved. Deliberately low until it's
 * calibrated on real photos; a blurry card still can't be saved wrongly, it just lands in review.
 */
const MIN_SHARPNESS = 2;

const toCandidate = (p: Printing): Candidate => ({
  printing_id: p.id,
  name: p.name,
  set_code: p.set_code,
  collector_number: p.collector_number,
  colors: p.colors,
  front_type: p.front_type,
  img_ver: p.img_ver,
  score: null,
});

type Result = { status: ScanStatus | 'blurry'; title: string; detail: string; ms: number; sharp?: number };

/**
 * Full-screen camera. Place the card in the guide and tap Capture; the card is read on the device and saved
 * (green / yellow) or put in the review queue (red). Never falls back to search without saying why.
 */
export function ScanView({ session, onClose, onSearch, onChanged }: {
  session: Session;
  onClose: () => void;
  onSearch: () => void;
  onChanged: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'starting' | 'live' | 'error'>('starting');
  const [error, setError] = useState(''); // camera problem
  const [ocrError, setOcrError] = useState('');
  const [busy, setBusy] = useState(false);
  const [torch, setTorchOn] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [last, setLast] = useState<Scan | null>(null);
  const [replaceNext, setReplaceNext] = useState(false);
  const [ocrReady, setOcrReady] = useState(false);
  const [askFinish, setAskFinish] = useState<{ printing: Printing; input: AddScanInput } | null>(null);
  const [view, setView] = useState({ w: 0, h: 0 });

  const start = useCallback(async () => {
    setState('starting');
    setError('');
    try {
      const stream = await openCamera();
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      setHasTorch(torchSupported(stream));
      setState('live');
    } catch (e) {
      setError(e instanceof CameraError ? e.message : errorText(e));
      setState('error');
    }
  }, []);

  useEffect(() => {
    start();
    warmUpOcr()
      .then(() => setOcrReady(true))
      .catch((e) => setOcrError(`Card reading couldn’t load (${errorText(e)}). Close the scanner and open it again; if it keeps happening, reload the app.`));
    db.lastScan(session.id).then(setLast);
    return () => stopCamera(streamRef.current);
  }, [start, session.id]);

  // Keep the guide box in sync with the preview size.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const ro = new ResizeObserver(() => setView({ w: v.clientWidth, h: v.clientHeight }));
    ro.observe(v);
    return () => ro.disconnect();
  }, []);

  /** Save the capture; `readName` labels a review-queue card in the result banner. */
  const save = async (input: AddScanInput, readName: string | null, ms: number, sharp?: number) => {
    const replacing = replaceNext && last;
    const s = replacing ? await db.replaceScan(last.id, input) : await db.addScan(session.id, input);
    setReplaceNext(false);
    setLast(s);
    feedback(s.status);
    const title = s.status === 'review' ? `Needs review: ${readName ?? 'unrecognized card'}` : `${s.name} [${s.set_code.toUpperCase()} ${s.collector_number}]`;
    const prefix = replacing ? 'Replaced last · ' : '';
    setResult({ status: s.status, title: prefix + title, detail: s.flag_reason, ms, sharp });
    onChanged();
  };

  const capture = async () => {
    const v = videoRef.current;
    if (!v || busy || state !== 'live') return;
    setBusy(true);
    try {
      const t0 = performance.now();
      const { card } = captureCard(v);
      const crops = prepareCrops(card);
      if (crops.sharpness < MIN_SHARPNESS) {
        feedback('review');
        setResult({ status: 'blurry', title: 'No card in focus: nothing saved', detail: 'Put the card inside the box, hold it still, and capture again.', ms: 0 });
        return;
      }
      const readings = await readCard(crops, browserOcr);
      const id = await db.identify({ nameTexts: readings.nameTexts, collectorText: readings.collectorText, bottomText: readings.bottomText });
      const photo = await cardJpeg(card);
      const ms = performance.now() - t0;
      const input: AddScanInput = {
        printing_id: id.status === 'review' ? null : id.printing!.id,
        candidates: id.candidates.map(toCandidate),
        status: id.status === 'review' ? undefined : id.status,
        confidence: id.confidence,
        flag_reason: id.flag,
        source: 'scan',
        photo,
      };
      if (id.printing && id.status !== 'review' && chooseFinish(id.printing.finishes, session.foil_mode).finish == null) {
        setAskFinish({ printing: id.printing, input });
        setResult({ status: id.status, title: `${id.printing.name}: pick the finish`, detail: '', ms });
        return;
      }
      await save(input, id.read.name?.name ?? null, ms, Math.round(crops.sharpness));
    } catch (e) {
      feedback('review');
      setResult({ status: 'review', title: 'Something went wrong: nothing saved', detail: errorText(e), ms: 0 });
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!last) return;
    await db.deleteScan(last.id);
    setResult({ status: 'review', title: `Undid ${last.name || `scan #${last.seq}`}`, detail: '', ms: 0 });
    setLast(await db.lastScan(session.id));
    setReplaceNext(false);
    onChanged();
  };

  const guide = view.w ? guideRect(view.w, view.h) : null;
  const color = result ? (result.status === 'saved' ? 'var(--ok)' : result.status === 'check' ? 'var(--check)' : 'var(--bad)') : undefined;

  return (
    <Sheet full onClose={onClose} title="Scan">
      <div className="scan">
        <video ref={videoRef} className="scan-video" muted playsInline autoPlay />
        {guide && state === 'live' && (
          <div className="scan-guide" style={{ left: guide.x, top: guide.y, width: guide.w, height: guide.h, borderColor: color }} />
        )}
        <div className="scan-top">
          <button className="btn" onClick={onClose}>Done</button>
          <div className="scan-mode">
            {FINISH_MODE[session.foil_mode]} · {session.default_condition}
          </div>
          {hasTorch && (
            <button className="btn" aria-pressed={torch} onClick={async () => { if (await setTorch(streamRef.current, !torch)) setTorchOn(!torch); }}>
              {torch ? 'Torch on' : 'Torch'}
            </button>
          )}
        </div>

        {state === 'error' && (
          <div className="scan-error panel warn">
            <h2>Camera unavailable</h2>
            <p>{error}</p>
            <div className="stack">
              <button className="btn primary block" onClick={start}>Try again</button>
              <button className="btn block" onClick={onSearch}>Search / add by name instead</button>
            </div>
          </div>
        )}
        {state === 'starting' && <div className="scan-msg">Starting camera…</div>}

        <div className="scan-bottom">
          {result && (
            <div className="scan-result" style={{ borderColor: color }}>
              <div className="name">{result.title}</div>
              {result.detail && <div className="sub">{result.detail}</div>}
              {result.ms > 0 && <div className="sub">{(result.ms / 1000).toFixed(1)} s · sharpness {result.sharp}</div>}
            </div>
          )}
          {ocrError && <p className="err small" style={{ background: 'rgba(0,0,0,0.7)', padding: 8, borderRadius: 8 }}>{ocrError}</p>}
          <div className="row-gap">
            <button className="btn" style={{ flex: 1 }} disabled={!last || busy} onClick={undo}>Undo</button>
            <button className="btn" style={{ flex: 1.3 }} aria-pressed={replaceNext} disabled={!last || busy} onClick={() => setReplaceNext(!replaceNext)}>
              {replaceNext ? 'Replacing last…' : 'Replace last'}
            </button>
            <button className="btn" style={{ flex: 1 }} onClick={onSearch}>Search</button>
          </div>
          <button className="btn primary big block" disabled={state !== 'live' || busy || !ocrReady} onClick={capture}>
            {busy ? 'Reading…' : ocrError ? 'Card reading unavailable' : !ocrReady ? 'Loading reader…' : replaceNext ? 'Capture (replaces last)' : 'Capture'}
          </button>
        </div>

        {askFinish && (
          <div className="scan-error panel">
            <h2>{askFinish.printing.name}</h2>
            <div className="stack">
              {askFinish.printing.finishes.map((f: Finish) => (
                <button
                  key={f}
                  className={`btn big block${f !== 'nonfoil' ? ' primary' : ''}`}
                  onClick={async () => {
                    const pending = askFinish;
                    setAskFinish(null);
                    await save({ ...pending.input, finish: f }, pending.printing.name, 0);
                  }}
                >
                  {FINISH_LABEL[f]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

const FINISH_MODE = { nonfoil: 'Non-foil session', foil: 'Foil session', ask: 'Ask finish' } as const;
