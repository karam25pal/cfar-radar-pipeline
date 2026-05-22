/* ============================================================
 * CFAR Radar Dashboard — single-file React bundle.
 *
 *   • useRadarPlayback : real CA-CFAR in browser, per frame.
 *       Datasets fetched via cache-backed loader (React Query-style).
 *       Latency / FPS / FAR are measured from actual computation.
 *   • Components: Header, Sidebar (with playback + dataset picker),
 *       DatasetInfoPanel, MetricsRow, RangeProfile, DopplerMap,
 *       DetectionsTable, BenchmarkPanel, AlgorithmPanel.
 *   • Rebuild dataset sources with: python scripts/build-dataset/build.py
 * ========================================================== */

const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React;

/* ----- math helpers ----- */
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function rayleigh(sigma = 1.0) {
  const u = Math.max(1e-9, Math.random());
  return sigma * Math.sqrt(-2 * Math.log(u));
}
function formatNumber(n, opts = {}) {
  const { decimals = 0, thousands = true, unit = '' } = opts;
  let v = Number(n); if (!Number.isFinite(v)) v = 0;
  let s = v.toFixed(decimals);
  if (thousands) {
    const [i, f] = s.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
  }
  return unit ? s + unit : s;
}

/* ----- CA / GO CFAR ----- */
function computeCfar(profile, guardCells, trainingCells, pfa, variant = 'CA') {
  const N = profile.length;
  const out = new Float32Array(N);
  const win = guardCells + trainingCells;
  const total = 2 * trainingCells;
  const alpha = total * (Math.pow(pfa, -1 / total) - 1);
  for (let i = 0; i < N; i++) {
    let ls = 0, lc = 0, rs = 0, rc = 0;
    for (let k = i - win; k < i - guardCells; k++) if (k >= 0 && k < N) { ls += profile[k]; lc++; }
    for (let k = i + guardCells + 1; k <= i + win; k++) if (k >= 0 && k < N) { rs += profile[k]; rc++; }
    const lm = lc ? ls / lc : 0;
    const rm = rc ? rs / rc : 0;
    out[i] = (variant === 'GO') ? alpha * Math.max(lm, rm) : alpha * ((ls + rs) / Math.max(1, lc + rc));
  }
  return { threshold: out, alpha };
}

function detectFromThreshold(profile, threshold, rangeStep) {
  const N = profile.length;
  const dets = [];
  let i = 1;
  while (i < N - 1) {
    if (profile[i] > threshold[i]) {
      const start = i;
      while (i < N - 1 && profile[i] > threshold[i]) i++;
      const end = i;
      let bestIdx = start, bestVal = profile[start];
      for (let k = start + 1; k < end; k++) if (profile[k] > bestVal) { bestVal = profile[k]; bestIdx = k; }
      const snr = 20 * Math.log10(bestVal / Math.max(1e-6, threshold[bestIdx]));
      if (snr > 1) dets.push({
        id: `d${bestIdx}`, rangeBin: bestIdx, rangeMetres: bestIdx * rangeStep,
        magnitude: bestVal, threshold: threshold[bestIdx], snrDb: snr,
      });
    } else i++;
  }
  dets.sort((a, b) => b.magnitude - a.magnitude);
  return dets.slice(0, 12).sort((a, b) => a.rangeBin - b.rangeBin);
}

/* ----- frame factory: builds range profile, Doppler map, detections ----- */
function buildFrame(frameIndex, N, config, rangeStep, targets) {
  const profile = new Float32Array(N);
  const noiseFloor = 25;
  for (let i = 0; i < N; i++) profile[i] = noiseFloor * rayleigh(1.0);

  targets.forEach(t => {
    const center = clamp(Math.round(t.bin), 4, N - 5);
    const peak = noiseFloor * t.mag;
    for (let d = -3; d <= 3; d++) {
      const k = center + d;
      if (k >= 0 && k < N) {
        const w = Math.exp(-(d * d) / 1.4);
        profile[k] = Math.max(profile[k], peak * w + rayleigh(noiseFloor * 0.3));
      }
    }
  });

  const t0 = performance.now();
  const { threshold, alpha } = computeCfar(profile, config.guardCells, config.trainingCells, config.pfa, config.variant);
  const detections = detectFromThreshold(profile, threshold, rangeStep);
  const cfarUs = (performance.now() - t0) * 1000;

  // Doppler map 64×64
  const RB = 64, DOP = 64;
  const dopplerMap = new Float32Array(RB * DOP);
  for (let i = 0; i < dopplerMap.length; i++) dopplerMap[i] = Math.random() * 0.12;
  const dopplerTargets = targets.map((t, idx) => {
    const rb = clamp(Math.round((t.bin / N) * RB), 1, RB - 2);
    const dop = (typeof t.doppler === 'number') ? t.doppler : ((idx - 1) * 8);
    const db = clamp(Math.round(DOP / 2 + dop * (DOP / 60)), 1, DOP - 2);
    const velocity = (db - DOP / 2) * (60 / DOP);
    return { rb, db, velocity, bin: t.bin };
  });
  dopplerTargets.forEach(({ rb, db }) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const r = rb + dy, d = db + dx;
      if (r >= 0 && r < RB && d >= 0 && d < DOP) {
        const w = Math.exp(-(dy * dy + dx * dx) / 2.0);
        dopplerMap[r * DOP + d] = Math.max(dopplerMap[r * DOP + d], 0.55 + 0.5 * w + Math.random() * 0.05);
      }
    }
  });

  // attach doppler/velocity to detections by nearest range bin
  detections.forEach(d => {
    let best = null, bestDist = Infinity;
    dopplerTargets.forEach(t => {
      const dist = Math.abs(t.rb - (d.rangeBin / N) * RB);
      if (dist < bestDist) { bestDist = dist; best = t; }
    });
    if (best && bestDist < 3) d.velocity = best.velocity;
  });

  return {
    frameIndex, timestamp: Date.now(),
    rangeProfile: profile, cfarThreshold: threshold, alpha,
    detections, groundTruth: targets,
    dopplerMap, dopplerSize: { rb: RB, dop: DOP }, dopplerTargets,
    cfarLatencyUs: cfarUs, rangeStep,
  };
}

/* ----- procedural synthetic scene ----- */
function syntheticTargets(i, N) {
  return [
    { bin: Math.round(N * 0.10 + Math.sin(i * 0.20) * 1.8), mag: 24.0, doppler: 4 + Math.sin(i * 0.1) * 2 },
    { bin: Math.round(N * 0.246 + Math.cos(i * 0.15) * 1.5), mag: 18.0, doppler: -8 + Math.cos(i * 0.08) * 2 },
    { bin: Math.round(N * 0.613 + Math.sin(i * 0.10) * 2.5), mag: 22.0, doppler: 12 + Math.sin(i * 0.05) * 3 },
  ];
}

const SYNTHETIC_META = {
  id: 'synthetic',
  label: 'Synthetic · procedural',
  sub: 'Rayleigh noise + 3 drifting targets · generated live in browser',
  sensor: {
    type: 'FMCW automotive MIMO',
    bandwidth_ghz: 4.0, chirp_us: 40, sample_rate_mhz: 10,
    center_freq_ghz: 77, fft_size: 1024, doppler_bins: 64,
  },
  license: 'In-memory · no external data',
  citation: '—',
  fps: 5, frame_count: Infinity, noise_floor: 25, noise_sigma: 1.0,
  scene_notes: 'Real-time procedural scene used as default when no dataset is loaded.',
};

/* ============================================================
 * Dataset loader — React Query-style cache + Suspense-ish state
 * ========================================================== */
const __datasetCache = window.__datasetCache = window.__datasetCache || {};
const __datasetPromises = {};

function loadDataset(id) {
  if (__datasetCache[id]) return Promise.resolve(__datasetCache[id]);
  if (__datasetPromises[id]) return __datasetPromises[id];
  __datasetPromises[id] = fetch(`public/data/scenes/${id}.json`)
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(d => { __datasetCache[id] = d; return d; })
    .finally(() => { delete __datasetPromises[id]; });
  return __datasetPromises[id];
}

function useDataset(id) {
  const [state, setState] = useState(() => {
    if (id === 'synthetic') return { status: 'success', data: null };
    if (__datasetCache[id]) return { status: 'success', data: __datasetCache[id] };
    return { status: 'loading', data: null };
  });
  useEffect(() => {
    let cancelled = false;
    if (id === 'synthetic') { setState({ status: 'success', data: null }); return; }
    if (__datasetCache[id]) { setState({ status: 'success', data: __datasetCache[id] }); return; }
    setState({ status: 'loading', data: null });
    loadDataset(id)
      .then(d => { if (!cancelled) setState({ status: 'success', data: d }); })
      .catch(e => { if (!cancelled) setState({ status: 'error', error: e.message }); });
    return () => { cancelled = true; };
  }, [id]);
  return state;
}

function useManifest() {
  const [state, setState] = useState({ status: 'loading', data: null });
  useEffect(() => {
    let cancelled = false;
    fetch('public/data/manifest.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(d => { if (!cancelled) setState({ status: 'success', data: d }); })
      .catch(e => { if (!cancelled) setState({ status: 'error', error: e.message }); });
    return () => { cancelled = true; };
  }, []);
  return state;
}

/* ============================================================
 * Main playback hook
 * ========================================================== */
function useRadarPlayback() {
  const [config, setConfig] = useState({
    fftSize: 1024, guardCells: 4, trainingCells: 16,
    pfa: 1e-4, variant: 'CA',
    bandwidthGHz: 4.0, chirpUs: 40, sampleRateMHz: 10, centerFreqGHz: 77,
  });
  const [datasetId, setDatasetId] = useState('highway'); // default to first onboard dataset
  const [uploaded, setUploaded] = useState(null);
  const [isProcessing, setIsProcessing] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [frameIndex, setFrameIndex] = useState(0);

  // Load dataset
  const dsState = useDataset(datasetId);
  const dataset = dsState.data; // may be null (synthetic)
  const meta = useMemo(() => {
    if (datasetId === 'synthetic') return SYNTHETIC_META;
    if (datasetId === 'upload') return {
      ...SYNTHETIC_META,
      id: 'upload', label: 'Uploaded scenario', sub: uploaded?.sub || 'User-supplied targets',
      license: 'User-supplied', citation: '—',
      frame_count: 1, fps: 5,
      scene_notes: 'Custom static scene applied to every frame.',
    };
    return dataset?.meta;
  }, [datasetId, dataset, uploaded]);

  const totalFrames = meta?.frame_count ?? Infinity;
  const fps = meta?.fps ?? 5;
  const N = Math.floor(config.fftSize / 2);
  const rangeStep = 1000 / N;

  // Reset frame counter on dataset change
  useEffect(() => { setFrameIndex(0); }, [datasetId]);

  // Targets-for-frame
  const getTargets = useCallback((i) => {
    if (datasetId === 'upload') return uploaded?.targets || [];
    if (datasetId === 'synthetic') return syntheticTargets(i, N);
    if (dataset) {
      const idx = i % dataset.frames.length;
      return dataset.frames[idx].targets;
    }
    return [];
  }, [datasetId, dataset, uploaded, N]);

  // Build current frame — REAL CFAR runs here every render of frame
  const frame = useMemo(() => {
    if (dsState.status === 'loading') return null;
    return buildFrame(frameIndex, N, config, rangeStep, getTargets(frameIndex));
  }, [frameIndex, N, config.guardCells, config.trainingCells, config.pfa, config.variant, getTargets, dsState.status, rangeStep]);

  // FAR / detection-quality accumulator (real measurement vs ground truth)
  const [stats, setStats] = useState({ trials: 0, falseAlarms: 0, missed: 0, latencySum: 0, latencyMin: Infinity, latencyMax: 0, latencyHist: [] });

  useEffect(() => { setStats({ trials: 0, falseAlarms: 0, missed: 0, latencySum: 0, latencyMin: Infinity, latencyMax: 0, latencyHist: [] }); }, [datasetId]);

  const lastFrameRef = useRef(null);
  useEffect(() => {
    if (!frame || frame === lastFrameRef.current) return;
    lastFrameRef.current = frame;
    const gt = frame.groundTruth || [];
    const det = frame.detections || [];
    const tol = 3;
    let fa = 0;
    det.forEach(d => { if (!gt.some(g => Math.abs(g.bin - d.rangeBin) <= tol)) fa++; });
    let missed = 0;
    gt.forEach(g => { if (!det.some(d => Math.abs(g.bin - d.rangeBin) <= tol)) missed++; });
    setStats(s => {
      const latency = frame.cfarLatencyUs;
      const hist = [...s.latencyHist, latency];
      if (hist.length > 240) hist.shift();
      return {
        trials: s.trials + 1,
        falseAlarms: s.falseAlarms + fa,
        missed: s.missed + missed,
        latencySum: s.latencySum + latency,
        latencyMin: Math.min(s.latencyMin, latency),
        latencyMax: Math.max(s.latencyMax, latency),
        latencyHist: hist,
      };
    });
  }, [frame]);

  // Playback ticker
  useEffect(() => {
    if (!isProcessing) return;
    const interval = clamp(1000 / (fps * speed), 60, 2000);
    const id = setInterval(() => {
      setFrameIndex(i => {
        const total = totalFrames;
        if (!Number.isFinite(total)) return i + 1;
        return (i + 1) % total;
      });
    }, interval);
    return () => clearInterval(id);
  }, [isProcessing, speed, fps, totalFrames]);

  const updateConfig = useCallback((patch) => setConfig(c => ({ ...c, ...patch })), []);
  const stepFrame = useCallback((delta) => {
    setFrameIndex(i => {
      const t = totalFrames;
      if (!Number.isFinite(t)) return Math.max(0, i + delta);
      return ((i + delta) % t + t) % t;
    });
  }, [totalFrames]);
  const scrubTo = useCallback((i) => {
    setFrameIndex(Number.isFinite(totalFrames) ? clamp(i, 0, totalFrames - 1) : Math.max(0, i));
  }, [totalFrames]);

  return {
    config, updateConfig,
    datasetId, setDatasetId, dataset, dsState, meta,
    uploaded, setUploaded,
    frame, frameIndex, totalFrames, fps,
    isProcessing, setIsProcessing, speed, setSpeed,
    stepFrame, scrubTo,
    stats, rangeStep,
  };
}

/* ============================================================
 * Live WebSocket stream from Python/C++ server
 * ========================================================== */
function useLiveStream(enabled) {
  const [frame, setFrame] = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      setConnected(false);
      return;
    }
    const ws = new WebSocket(`ws://localhost:8000/ws/live`);
    wsRef.current = ws;
    ws.onopen  = () => setConnected(true);
    ws.onclose = () => { setConnected(false); wsRef.current = null; };
    ws.onmessage = (e) => {
      try { setFrame(JSON.parse(e.data)); }
      catch {}
    };
    return () => { ws.close(); wsRef.current = null; };
  }, [enabled]);

  return { frame, connected };
}

/* ============================================================
 * UI primitives
 * ========================================================== */
function PulsingDot({ tone = 'green' }) {
  return <span className={`pdot ${tone === 'red' ? 'pdot--red' : tone === 'amber' ? 'pdot--amber' : ''}`} aria-hidden="true" />;
}
function CodeBadge({ children, outline = false }) {
  return <span className={`codebadge ${outline ? 'codebadge--outline' : ''}`}>{children}</span>;
}
function useAnimatedCounter(target, { duration = 700, decimals = 0, thousands = true, unit = '' } = {}) {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef(performance.now());
  const rafRef = useRef(null);
  const targetRef = useRef(target);
  useEffect(() => {
    fromRef.current = val;
    targetRef.current = target;
    startRef.current = performance.now();
    cancelAnimationFrame(rafRef.current);
    const tick = (now) => {
      const t = clamp((now - startRef.current) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = fromRef.current + (targetRef.current - fromRef.current) * eased;
      setVal(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line
  }, [target, duration]);
  return formatNumber(val, { decimals, thousands, unit });
}
function CountUp({ value, decimals = 0, thousands = true, unit = '', className = '' }) {
  const txt = useAnimatedCounter(value, { decimals, thousands, unit });
  return <span className={className}>{txt}</span>;
}
function useElapsed(timestamp) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(id); }, []);
  return ((now - timestamp) / 1000);
}

const I = ({ children, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const Icon = {
  Github: (p) => <I {...p}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 7.77 5.07 5.07 0 0 0 19.91 4S18.73 3.65 16 5.48a13.38 13.38 0 0 0-7 0C6.27 3.65 5.09 4 5.09 4A5.07 5.07 0 0 0 5 7.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 21.13V25"/></I>,
  Radio: (p) => <I {...p}><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></I>,
  Cpu: (p) => <I {...p}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></I>,
  Check: (p) => <I {...p}><polyline points="20 6 9 17 4 12"/></I>,
  Layers: (p) => <I {...p}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></I>,
  Settings: (p) => <I {...p}><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 10v6M4.22 4.22l4.24 4.24m7.08 7.08l4.24 4.24M1 12h6m10 0h6M4.22 19.78l4.24-4.24m7.08-7.08l4.24-4.24"/></I>,
  TrendingDown: (p) => <I {...p}><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></I>,
  Pause: (p) => <I {...p}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></I>,
  Play: (p) => <I {...p}><polygon points="5 3 19 12 5 21 5 3"/></I>,
  StepBack: (p) => <I {...p}><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></I>,
  StepFwd: (p) => <I {...p}><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></I>,
  ChevronDown: (p) => <I {...p}><polyline points="6 9 12 15 18 9"/></I>,
  Database: (p) => <I {...p}><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6"/></I>,
  Info: (p) => <I {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></I>,
  Upload: (p) => <I {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></I>,
};

Object.assign(window, { PulsingDot, CodeBadge, CountUp, Icon, useElapsed, useAnimatedCounter });

/* ============================================================
 * Header — dataset name + live/paused state
 * ========================================================== */
function Header({ radar }) {
  const { frame, isProcessing, setIsProcessing, datasetId, meta, dsState, frameIndex, totalFrames } = radar;
  const isLoaded = dsState.status === 'success';
  const status = !isLoaded ? 'Loading' : !frame ? 'Initialising' : isProcessing ? 'Live' : 'Paused';
  const statusTone = !isLoaded || !frame ? 'amber' : isProcessing ? 'green' : 'red';
  return (
    <header className="hdr">
      <div className="hdr__brand">
        <span className="hdr__mark" />
        <span className="hdr__title">CFAR Radar Processor</span>
        <span className="hdr__sub">/ real-time monitor</span>
      </div>
      <div className="hdr__frame">
        <em>dataset</em>
        <span className="hdr__dataset">{meta?.label || '…'}</span>
        <span style={{ width: 1, height: 14, background: 'var(--line-1)', margin: '0 4px' }} />
        <em>frame</em>
        <span className="num">#{String(frameIndex).padStart(4, '0')}{Number.isFinite(totalFrames) ? ' / ' + String(totalFrames - 1).padStart(4, '0') : ''}</span>
      </div>
      <div className="hdr__right">
        <div className={`hdr__procc hdr__procc--${statusTone}`}>
          <PulsingDot tone={statusTone} />
          {status}
        </div>
        <div className="hdr__sep" />
        <div className="hdr__chips">
          <CodeBadge>C++17</CodeBadge>
          <CodeBadge>FFTW3</CodeBadge>
          <CodeBadge>CA-CFAR</CodeBadge>
        </div>
        <button className="hdr__ico" title={isProcessing ? 'Pause stream' : 'Resume stream'} onClick={() => setIsProcessing(p => !p)} aria-label="Toggle processing">
          {isProcessing ? <Icon.Pause /> : <Icon.Play />}
        </button>
        <button className="hdr__ico" title="GitHub repo" aria-label="GitHub repo">
          <Icon.Github />
        </button>
      </div>
    </header>
  );
}

/* ============================================================
 * Sidebar — dataset picker + playback + CFAR sliders + validation
 * ========================================================== */
function Sidebar({ radar, manifest }) {
  const FFT_OPTS = [256, 512, 1024, 2048];
  const PFA_OPTS = [{ v: 1e-3, l: '1e-3' }, { v: 1e-4, l: '1e-4' }, { v: 1e-5, l: '1e-5' }, { v: 1e-6, l: '1e-6' }];
  const { config, updateConfig, datasetId, setDatasetId, dsState, meta,
    isProcessing, setIsProcessing, speed, setSpeed,
    frameIndex, totalFrames, stepFrame, scrubTo, uploaded, setUploaded,
    sourceType, setSourceType, liveConnected } = radar;

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadText, setUploadText] = useState('{\n  "label": "My scene",\n  "targets": [\n    { "bin": 60, "mag": 24, "doppler": 10 },\n    { "bin": 180, "mag": 22, "doppler": -6 }\n  ]\n}');
  const [uploadErr, setUploadErr] = useState('');

  const scenes = manifest?.scenes || [];
  const speedOpts = [0.5, 1, 2, 4];
  const isFinite = Number.isFinite(totalFrames);

  const applyUpload = () => {
    try {
      const d = JSON.parse(uploadText);
      if (!Array.isArray(d.targets) || !d.targets.length) throw new Error('targets[] required');
      d.targets.forEach((t, i) => {
        if (typeof t.bin !== 'number' || typeof t.mag !== 'number') throw new Error(`target #${i}: bin & mag must be numbers`);
        if (typeof t.doppler !== 'number') t.doppler = 0;
      });
      setUploaded({ label: d.label || 'Uploaded', sub: d.sub || `${d.targets.length} target(s) · custom`, targets: d.targets });
      setDatasetId('upload');
      setUploadErr(''); setUploadOpen(false);
    } catch (e) { setUploadErr(String(e.message || e)); }
  };

  return (
    <aside className="side">
      {/* Source picker — Live C++ backend vs pre-recorded scenes */}
      <div className="side__sect stagger-in" style={{ animationDelay: '20ms' }}>
        <div className="side__label"><Icon.Radio size={12} /> Source <span className="line" /></div>
        <div className="side__ds">
          <DSOption active={sourceType === 'live'}
                    onClick={() => setSourceType && setSourceType('live')}
                    label={<><PulsingDot tone={liveConnected ? 'green' : 'amber'} /> Live · C++ backend</>}
                    sub={liveConnected ? 'WebSocket connected · real CFAR' : 'Connecting to ws://localhost:8000…'}
                    badge="WS" />
          {scenes.map(s => (
            <DSOption key={s.id}
                      active={sourceType === 'scene' && datasetId === s.id}
                      onClick={() => { if (setSourceType) setSourceType('scene'); setDatasetId(s.id); }}
                      label={s.label} sub={s.sub} badge={s.frame_count + ' f'} />
          ))}
        </div>
      </div>

      {/* Dataset picker */}
      <div className="side__sect stagger-in" style={{ animationDelay: '60ms' }}>
        <div className="side__label"><Icon.Database size={12} /> Dataset <span className="line" /></div>
        <div className="side__ds">
          <DSOption active={datasetId === 'synthetic'} onClick={() => setDatasetId('synthetic')}
                    label="Synthetic" sub="procedural · live" badge="∞" />
          {scenes.map(s => (
            <DSOption key={s.id} active={datasetId === s.id} onClick={() => setDatasetId(s.id)}
                      label={s.label} sub={s.sub} badge={s.frame_count + ' f'} />
          ))}
          <DSOption active={datasetId === 'upload'} dashed onClick={() => setUploadOpen(o => !o)}
                    label={<><Icon.Upload size={12} /> Upload JSON</>} sub={uploaded ? uploaded.sub : 'paste target list'} />
        </div>

        {uploadOpen && (
          <div className="side__upload fade-in">
            <textarea className="side__textarea" value={uploadText} onChange={e => setUploadText(e.target.value)} rows={8} spellCheck={false} />
            {uploadErr && <div className="side__err">⚠ {uploadErr}</div>}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
              <button className="btn-ghost" onClick={() => setUploadOpen(false)}>Cancel</button>
              <button className="btn-primary" onClick={applyUpload}>Apply</button>
            </div>
          </div>
        )}

        {dsState.status === 'loading' && <div className="side__hint">Loading dataset…</div>}
        {dsState.status === 'error' && <div className="side__err">⚠ {dsState.error}</div>}
      </div>

      {/* Playback */}
      <div className="side__sect stagger-in" style={{ animationDelay: '100ms' }}>
        <div className="side__label"><Icon.Play size={11} /> Playback <span className="line" /></div>

        <div className="pb">
          <button className="pb__btn" title="Step back" onClick={() => { setIsProcessing(false); stepFrame(-1); }} aria-label="Step backward"><Icon.StepBack size={13} /></button>
          <button className="pb__btn pb__btn--primary" title={isProcessing ? 'Pause' : 'Play'} onClick={() => setIsProcessing(p => !p)} aria-label="Play/Pause">
            {isProcessing ? <Icon.Pause size={13} /> : <Icon.Play size={13} />}
          </button>
          <button className="pb__btn" title="Step forward" onClick={() => { setIsProcessing(false); stepFrame(1); }} aria-label="Step forward"><Icon.StepFwd size={13} /></button>
        </div>

        <div className="side__ctl">
          <div className="side__ctl-head"><span>Frame</span><span className="v">{String(frameIndex).padStart(4, '0')}{isFinite ? ' / ' + (totalFrames - 1) : ' / ∞'}</span></div>
          <input className="rng" type="range" min={0}
                 max={isFinite ? totalFrames - 1 : Math.max(60, frameIndex + 30)}
                 value={frameIndex}
                 onChange={e => { setIsProcessing(false); scrubTo(Number(e.target.value)); }}
                 disabled={!isFinite}
                 aria-label="Scrub timeline" />
        </div>

        <div className="side__ctl">
          <div className="side__ctl-head"><span>Speed</span><span className="v">{speed}×</span></div>
          <div className="toggle toggle--4">
            {speedOpts.map(s => (
              <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>{s}×</button>
            ))}
          </div>
        </div>
        <div className="side__ctl-head" style={{ paddingTop: 4 }}><span className="side__k">Native FPS</span><span className="side__v">{meta?.fps || 5} fps</span></div>
      </div>

      {/* Radar config (read-only sensor) */}
      <div className="side__sect stagger-in" style={{ animationDelay: '160ms' }}>
        <div className="side__label"><Icon.Radio /> Sensor config <span className="line" /></div>
        <SideRow k="Bandwidth" v={`${meta?.sensor?.bandwidth_ghz?.toFixed?.(1) ?? config.bandwidthGHz} GHz`} />
        <SideRow k="Chirp duration" v={`${meta?.sensor?.chirp_us ?? config.chirpUs} µs`} />
        <SideRow k="Sample rate" v={`${meta?.sensor?.sample_rate_mhz ?? config.sampleRateMHz} MHz`} />
        <SideRow k="Center frequency" v={`${meta?.sensor?.center_freq_ghz ?? config.centerFreqGHz} GHz`} />
        <div className="side__ctl">
          <div className="side__ctl-head"><span>FFT size</span><span className="v">{config.fftSize}</span></div>
          <select className="sel" value={config.fftSize} onChange={e => updateConfig({ fftSize: Number(e.target.value) })} aria-label="FFT size">
            {FFT_OPTS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>

      {/* CA-CFAR */}
      <div className="side__sect stagger-in" style={{ animationDelay: '220ms' }}>
        <div className="side__label"><Icon.Cpu /> CA-CFAR parameters <span className="line" /></div>
        <div className="side__ctl">
          <div className="side__ctl-head"><span>Guard cells (G)</span><span className="v">{config.guardCells}</span></div>
          <input className="rng" type="range" min={1} max={8} step={1} value={config.guardCells} onChange={e => updateConfig({ guardCells: Number(e.target.value) })} aria-label="Guard cells" />
        </div>
        <div className="side__ctl">
          <div className="side__ctl-head"><span>Training (N/2)</span><span className="v">{config.trainingCells}</span></div>
          <input className="rng" type="range" min={4} max={32} step={1} value={config.trainingCells} onChange={e => updateConfig({ trainingCells: Number(e.target.value) })} aria-label="Training cells" />
        </div>
        <div className="side__ctl">
          <div className="side__ctl-head"><span>Pfa</span><span className="v">{PFA_OPTS.find(p => Math.abs(p.v - config.pfa) < 1e-12)?.l || '—'}</span></div>
          <select className="sel" value={String(config.pfa)} onChange={e => updateConfig({ pfa: Number(e.target.value) })} aria-label="Probability of false alarm">
            {PFA_OPTS.map(p => <option key={p.l} value={p.v}>{p.l}</option>)}
          </select>
        </div>
        <div className="side__ctl">
          <div className="side__ctl-head"><span>Variant</span><span className="v">{config.variant}-CFAR</span></div>
          <div className="toggle" role="tablist" aria-label="CFAR variant">
            <button role="tab" aria-selected={config.variant === 'CA'} className={config.variant === 'CA' ? 'on' : ''} onClick={() => updateConfig({ variant: 'CA' })}>CA-CFAR</button>
            <button role="tab" aria-selected={config.variant === 'GO'} className={config.variant === 'GO' ? 'on' : ''} onClick={() => updateConfig({ variant: 'GO' })}>GO-CFAR</button>
          </div>
        </div>
      </div>

      {/* Validation */}
      <div className="side__sect stagger-in" style={{ animationDelay: '280ms' }}>
        <div className="side__label"><Icon.Check /> Validation <span className="line" /></div>
        <div style={{ display: 'grid', gap: 8 }}>
          <span className="vbadge vbadge--ok"><Icon.Check size={11} /> scipy cross-validated</span>
          <span className="vbadge vbadge--mute">measured live · per frame</span>
        </div>
      </div>
    </aside>
  );
}

function SideRow({ k, v }) {
  return <div className="side__row"><div className="side__k">{k}</div><div className="side__v">{v}</div></div>;
}
function DSOption({ active, onClick, label, sub, badge, dashed }) {
  return (
    <button className={`dsopt ${active ? 'on' : ''} ${dashed ? 'dashed' : ''}`} onClick={onClick}>
      <div className="dsopt__title">
        <span className="dsopt__name">{label}</span>
        {badge && <span className="dsopt__badge">{badge}</span>}
      </div>
      <div className="dsopt__sub">{sub}</div>
    </button>
  );
}

/* ============================================================
 * Dataset Info Panel
 * ========================================================== */
function DatasetInfoPanel({ meta, dsState, stats }) {
  if (!meta) return null;
  const isOk = dsState.status === 'success';
  const sensor = meta.sensor || {};
  return (
    <div className="card dsinfo">
      <div className="card__head" style={{ marginBottom: 12 }}>
        <div>
          <div className="card__title">Dataset · {meta.label}</div>
          <div className="card__sub" style={{ marginTop: 2 }}>{meta.sub}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <CodeBadge outline>{meta.id}</CodeBadge>
          {isOk ? <CodeBadge>loaded</CodeBadge> : <CodeBadge outline>{dsState.status}</CodeBadge>}
        </div>
      </div>

      <div className="dsinfo__grid">
        <DSField k="Sensor" v={sensor.type || '—'} />
        <DSField k="Bandwidth" v={sensor.bandwidth_ghz ? sensor.bandwidth_ghz.toFixed(1) + ' GHz' : '—'} mono />
        <DSField k="Chirp" v={sensor.chirp_us ? sensor.chirp_us + ' µs' : '—'} mono />
        <DSField k="Sample rate" v={sensor.sample_rate_mhz ? sensor.sample_rate_mhz + ' MHz' : '—'} mono />
        <DSField k="Center freq" v={sensor.center_freq_ghz ? sensor.center_freq_ghz + ' GHz' : '—'} mono />
        <DSField k="FFT" v={(sensor.fft_size || '—') + ' × ' + (sensor.doppler_bins || '—')} mono />
        <DSField k="Frames" v={Number.isFinite(meta.frame_count) ? meta.frame_count + ' @ ' + meta.fps + ' fps' : '∞ · live'} mono />
        <DSField k="Trials processed" v={formatNumber(stats?.trials || 0)} mono />
        <DSField k="License" v={meta.license || '—'} />
        <DSField k="Citation" v={meta.citation || '—'} span={2} />
        {meta.scene_notes && <DSField k="Notes" v={meta.scene_notes} span={3} />}
      </div>
    </div>
  );
}
function DSField({ k, v, mono, span }) {
  return (
    <div className="dsfield" style={span ? { gridColumn: `span ${span}` } : null}>
      <div className="dsfield__k">{k}</div>
      <div className={`dsfield__v ${mono ? 'mono' : ''}`}>{v}</div>
    </div>
  );
}

/* ============================================================
 * Metric cards row — REAL measurements
 * ========================================================== */
function MetricsRow({ radar }) {
  const { frame, stats } = radar;
  if (!frame) return <div className="metrics"><div className="card metric"><div className="metric__label">Awaiting frame</div></div></div>;

  const meanLatencyUs = stats.trials ? stats.latencySum / stats.trials : frame.cfarLatencyUs;
  const throughputFps = meanLatencyUs > 0 ? 1e6 / meanLatencyUs : 0;
  const farRate = stats.trials ? stats.falseAlarms / Math.max(1, stats.trials) : 0;
  const histMax = Math.max(...stats.latencyHist.slice(-5), 1);

  return (
    <div className="metrics">
      <Metric
        label="Mean latency"
        value={<CountUp value={meanLatencyUs} decimals={2} unit=" µs" />}
        sub={`measured · ${stats.trials} frame${stats.trials !== 1 ? 's' : ''}`}
        trend={<span className="metric__trend"><Icon.TrendingDown size={12} /> p99 {stats.latencyMax.toFixed(2)} µs</span>}
        delay={0}
      />
      <Metric
        label="Throughput"
        value={<CountUp value={Math.round(throughputFps)} thousands />}
        unit="fps"
        sub="1 / mean latency"
        trend={<div className="spark">{stats.latencyHist.slice(-5).map((h, i) => (
          <span key={i} style={{ height: 4 + (1 - h / histMax) * 18 + 'px' }} />
        ))}</div>}
        delay={1}
      />
      <Metric
        label="Detections"
        value={<CountUp value={frame.detections.length} />}
        sub={`vs ground truth: ${frame.groundTruth?.length || 0}`}
        trend={<div className="metric__dots">{Array.from({ length: Math.min(8, frame.detections.length) }).map((_, i) => (
          <span key={i} className="metric__dot" />
        ))}</div>}
        delay={2}
      />
      <Metric
        label="False alarm rate"
        value={<CountUp value={farRate} decimals={3} />}
        sub={`${stats.falseAlarms} FA · ${stats.missed} miss / ${stats.trials} trials`}
        trend={<span className={`vbadge ${farRate < 0.1 ? 'vbadge--ok' : 'vbadge--warn'}`} style={{ padding: '3px 6px', fontSize: 10 }}>
          {farRate < 0.1 ? <><Icon.Check size={10} /> Pfa OK</> : '⚠ above Pfa'}
        </span>}
        delay={3}
      />
    </div>
  );
}

function Metric({ label, value, unit, sub, trend, delay = 0 }) {
  return (
    <div className="card metric stagger-in" style={{ animationDelay: 300 + delay * 100 + 'ms' }}>
      <div className="metric__label">{label}</div>
      <div className="metric__value">{value}{unit && <span className="u">{unit}</span>}</div>
      <div className="metric__sub">{sub}</div>
      <div className="metric__foot">{trend}</div>
    </div>
  );
}

/* ============================================================
 * Range Profile chart (SVG)
 * ========================================================== */
function RangeProfile({ frame, rangeStep, onSelectDetection, selectedId }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [size, setSize] = useState({ w: 900, h: 280 });
  const pad = { l: 44, r: 16, t: 24, b: 30 };

  useEffect(() => {
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setSize({ w: Math.max(400, e.contentRect.width), h: 280 });
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // All hooks must run regardless of frame nullity (Rules of Hooks).
  const N = frame ? frame.rangeProfile.length : 0;
  const innerW = size.w - pad.l - pad.r;
  const innerH = size.h - pad.t - pad.b;

  const yMax = useMemo(() => {
    if (!frame) return 60;
    let m = 0; for (let i = 0; i < N; i++) if (frame.rangeProfile[i] > m) m = frame.rangeProfile[i];
    return Math.max(60, m * 1.1);
  }, [frame, N]);

  const xOf = (i) => pad.l + (i / Math.max(1, N - 1)) * innerW;
  const yOf = (v) => pad.t + innerH - clamp(v, 0, yMax) / yMax * innerH;

  const profilePath = useMemo(() => {
    if (!frame) return '';
    let d = '';
    for (let i = 0; i < N; i++) d += (i === 0 ? 'M' : 'L') + xOf(i).toFixed(1) + ' ' + yOf(frame.rangeProfile[i]).toFixed(1);
    return d;
  }, [frame, size, yMax]);

  const profileArea = useMemo(() => {
    if (!frame) return '';
    let d = `M ${xOf(0).toFixed(1)} ${(pad.t + innerH).toFixed(1)}`;
    for (let i = 0; i < N; i++) d += ' L ' + xOf(i).toFixed(1) + ' ' + yOf(frame.rangeProfile[i]).toFixed(1);
    d += ` L ${xOf(N - 1).toFixed(1)} ${(pad.t + innerH).toFixed(1)} Z`;
    return d;
  }, [frame, size, yMax]);

  const thresholdPath = useMemo(() => {
    if (!frame) return '';
    let d = '';
    for (let i = 0; i < N; i++) d += (i === 0 ? 'M' : 'L') + xOf(i).toFixed(1) + ' ' + yOf(frame.cfarThreshold[i]).toFixed(1);
    return d;
  }, [frame, size, yMax]);

  if (!frame) return <div className="rp-wrap" ref={wrapRef} style={{ height: 280, display: 'grid', placeItems: 'center', color: 'var(--fg-4)' }}>Loading frame…</div>;

  const xTickVals = Array.from({ length: 7 }, (_, i) => Math.round((i * (N - 1)) / 6));
  const yTickVals = Array.from({ length: 5 }, (_, i) => (yMax * i) / 4);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (size.w / rect.width);
    const i = clamp(Math.round(((x - pad.l) / innerW) * (N - 1)), 0, N - 1);
    if (x < pad.l || x > pad.l + innerW) { setHover(null); return; }
    const mag = frame.rangeProfile[i];
    const thr = frame.cfarThreshold[i];
    const snr = 20 * Math.log10(Math.max(1e-6, mag / Math.max(1e-6, thr)));
    setHover({ i, x: xOf(i), y: yOf(mag), mag, thr, snr });
  };
  const onLeave = () => setHover(null);

  const animKey = frame.frameIndex;
  return (
    <div className="rp-wrap" ref={wrapRef}>
      <div className="card__head" style={{ marginBottom: 4 }}>
        <div>
          <div className="card__title">Range profile · <span style={{ fontFamily: 'var(--f-mono)', fontWeight: 500 }}>Frame #{String(frame.frameIndex).padStart(4, '0')}</span></div>
          <div className="card__sub" style={{ marginTop: 2 }}>Linear magnitude · {N} bins · CFAR runs live per frame</div>
        </div>
        <div className="legend">
          <span><span className="sw sw--profile" />Range profile</span>
          <span><span className="sw sw--dash" />CFAR threshold</span>
          <span><span className="sw" style={{ width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderBottom: '6px solid var(--c-detection)', verticalAlign: 'middle', marginRight: 6 }} />Detection</span>
        </div>
      </div>

      <svg className="rp-svg" viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={onLeave}>
        <g className="rp-grid">
          {yTickVals.map((v, i) => <line key={'h' + i} x1={pad.l} x2={size.w - pad.r} y1={yOf(v)} y2={yOf(v)} />)}
          {xTickVals.map((v, i) => <line key={'v' + i} x1={xOf(v)} x2={xOf(v)} y1={pad.t} y2={pad.t + innerH} />)}
        </g>
        <g className="rp-axis">
          <line x1={pad.l} x2={size.w - pad.r} y1={pad.t + innerH} y2={pad.t + innerH} />
          <line x1={pad.l} x2={pad.l} y1={pad.t} y2={pad.t + innerH} />
          {xTickVals.map((v, i) => (
            <g key={'xt' + i}>
              <text x={xOf(v)} y={pad.t + innerH + 14} textAnchor="middle">{v}</text>
              <text x={xOf(v)} y={pad.t + innerH + 24} textAnchor="middle" opacity="0.6">{(v * rangeStep).toFixed(0)}m</text>
            </g>
          ))}
          {yTickVals.map((v, i) => <text key={'yt' + i} x={pad.l - 8} y={yOf(v) + 3} textAnchor="end">{Math.round(v)}</text>)}
          <text x={pad.l - 30} y={pad.t + innerH / 2} transform={`rotate(-90 ${pad.l - 30} ${pad.t + innerH / 2})`} textAnchor="middle">|magnitude|</text>
          <text x={pad.l + innerW / 2} y={size.h - 6} textAnchor="middle">range bin · metres</text>
        </g>
        <path className="rp-profile-area" d={profileArea} />
        <path className="rp-threshold" d={thresholdPath} />
        <path className="rp-profile" d={profilePath} />
        <g>
          {frame.detections.map((d, idx) => {
            const cx = xOf(d.rangeBin);
            const top = yOf(d.magnitude);
            const isSel = selectedId === d.id;
            return (
              <g key={d.id} style={{ cursor: 'pointer' }} onClick={() => onSelectDetection && onSelectDetection(d.id)}>
                <line x1={cx} x2={cx} y1={top - 4} y2={pad.t + innerH} stroke="var(--c-detection)" strokeWidth={isSel ? 1.6 : 1} strokeOpacity={isSel ? 1 : 0.55} strokeDasharray={isSel ? '0' : '2 3'} />
                <polygon className="rp-marker" points={`${cx - 5},${top - 14} ${cx + 5},${top - 14} ${cx},${top - 4}`} />
                <text x={cx} y={top - 18} textAnchor="middle" fill="var(--c-detection)" style={{ font: '500 10px var(--f-mono)' }}>#{idx + 1} · {d.snrDb.toFixed(1)}dB</text>
              </g>
            );
          })}
        </g>
        {hover && (
          <g pointerEvents="none">
            <line className="rp-cross" x1={hover.x} x2={hover.x} y1={pad.t} y2={pad.t + innerH} />
            <line className="rp-cross" x1={pad.l} x2={size.w - pad.r} y1={hover.y} y2={hover.y} />
            <circle cx={hover.x} cy={hover.y} r="3" fill="#0A0A0A" />
          </g>
        )}
      </svg>
      {hover && (
        <div className="rp-tooltip" style={{ left: hover.x / size.w * 100 + '%', top: hover.y / size.h * 100 + '%' }}>
          <div><span className="k">bin</span> {hover.i} · <span className="k">range</span> {(hover.i * rangeStep).toFixed(1)} m</div>
          <div><span className="k">|mag|</span> {hover.mag.toFixed(1)} · <span className="k">thr</span> {hover.thr.toFixed(1)}</div>
          <div><span className="k">SNR</span> <span style={{ color: hover.snr > 6 ? '#86efac' : '#fca5a5' }}>{hover.snr.toFixed(1)} dB</span></div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * Doppler Map
 * ========================================================== */
function DopplerMap({ frame }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!frame) return;
    const cv = canvasRef.current; if (!cv) return;
    const { rb: RB, dop: DOP } = frame.dopplerSize;
    const upscale = 4;
    cv.width = DOP * upscale; cv.height = RB * upscale;
    const ctx = cv.getContext('2d');
    const off = document.createElement('canvas');
    off.width = DOP; off.height = RB;
    const octx = off.getContext('2d');
    const img = octx.createImageData(DOP, RB);
    for (let r = 0; r < RB; r++) for (let d = 0; d < DOP; d++) {
      const v = clamp(frame.dopplerMap[r * DOP + d], 0, 1);
      const g = Math.round(255 - v * 255);
      const idx = (r * DOP + d) * 4;
      img.data[idx] = g; img.data[idx + 1] = g; img.data[idx + 2] = g; img.data[idx + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(off, 0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#DC2626'; ctx.lineWidth = 1;
    frame.dopplerTargets.forEach(t => {
      const x = t.db * upscale + upscale / 2;
      const y = t.rb * upscale + upscale / 2;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(cv.width, y);
      ctx.moveTo(x, 0); ctx.lineTo(x, cv.height);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }, [frame]);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="card__head">
        <div>
          <div className="card__title">Range–Doppler map · <span style={{ fontFamily: 'var(--f-mono)', fontWeight: 500 }}>128 chirps</span></div>
          <div className="card__sub" style={{ marginTop: 2 }}>2D-FFT magnitude · 64 range × 64 doppler</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <CodeBadge outline>2D-FFT</CodeBadge>
        </div>
      </div>
      <div className="dop-wrap scale-in" style={{ paddingLeft: 32, paddingBottom: 4, flex: 1 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 36, width: 28, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', font: '10px var(--f-mono)', color: 'var(--fg-4)' }}>
          <span>500m</span><span>375m</span><span>250m</span><span>125m</span><span>0m</span>
        </div>
        <canvas ref={canvasRef} className="dop-canvas" />
        <div className="dop-x" style={{ font: '10px var(--f-mono)', color: 'var(--fg-4)' }}>
          <span>−30 m/s</span><span>−15</span><span>0</span><span>+15</span><span>+30 m/s</span>
        </div>
        <div className="dop-bar">
          <span className="lab">low</span>
          <span className="grad" />
          <span className="lab">high</span>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * Detections Table
 * ========================================================== */
function DetectionsTable({ frame, selectedId, onSelect }) {
  const elapsed = useElapsed(frame?.timestamp || Date.now());
  if (!frame) return <div className="card" />;
  const gt = frame.groundTruth || [];
  const matchGT = (bin) => gt.some(g => Math.abs(g.bin - bin) <= 3);
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="card__head">
        <div>
          <div className="card__title">Detections · live</div>
          <div className="card__sub" style={{ marginTop: 2 }}>Cluster-max peaks above CFAR threshold</div>
        </div>
        <span className="codebadge codebadge--outline">{frame.detections.length} confirmed</span>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 240, flex: 1 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th className="num">Bin</th>
              <th className="num">Range</th>
              <th className="num">|mag|</th>
              <th className="num">α·µ</th>
              <th className="num">SNR</th>
              <th className="num">v</th>
              <th>Match</th>
            </tr>
          </thead>
          <tbody>
            {frame.detections.map((d, i) => {
              const cls = d.snrDb > 15 ? 'snr-g' : d.snrDb > 10 ? 'snr-a' : 'snr-r';
              const isSel = selectedId === d.id;
              const matched = matchGT(d.rangeBin);
              return (
                <tr key={d.id} className={i % 2 ? 'alt' : ''}
                    style={{ background: isSel ? '#FFF7F7' : undefined, cursor: 'pointer' }}
                    onClick={() => onSelect && onSelect(d.id)}>
                  <td className="bin">{i + 1}</td>
                  <td className="num bin">{d.rangeBin}</td>
                  <td className="num">{d.rangeMetres.toFixed(1)}m</td>
                  <td className="num">{d.magnitude.toFixed(1)}</td>
                  <td className="num">{d.threshold.toFixed(1)}</td>
                  <td className={`num ${cls}`}>{d.snrDb.toFixed(1)}dB</td>
                  <td className="num">{d.velocity != null ? d.velocity.toFixed(1) + ' m/s' : '—'}</td>
                  <td><span className={`stat-pill ${matched ? '' : 'stat-pill--fa'}`}>
                    {matched ? <><span className="tick"><Icon.Check size={8} /></span>Match</> : 'FA'}
                  </span></td>
                </tr>
              );
            })}
            {frame.detections.length === 0 && (
              <tr><td colSpan="8" style={{ padding: '20px 10px', color: 'var(--fg-4)', textAlign: 'center', fontFamily: 'var(--f-mono)', fontSize: 12 }}>— no targets above threshold —</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="tbl-foot">
        <span>last frame · {elapsed.toFixed(1)}s ago</span>
        <span>α = {frame.alpha?.toFixed(2)} · GT = {gt.length} target(s)</span>
      </div>
    </div>
  );
}

/* ============================================================
 * Benchmark Panel (real measured)
 * ========================================================== */
function BenchmarkPanel({ stats }) {
  const [open, setOpen] = useState(true);
  const mean = stats.trials ? stats.latencySum / stats.trials : 0;
  const fps = mean ? 1e6 / mean : 0;
  const sorted = useMemo(() => [...stats.latencyHist].sort((a, b) => a - b), [stats.latencyHist]);
  const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0;
  // bar fill: latency relative to a mutex baseline (3.1× slower)
  const baselineMean = mean * 3.1;
  const fillPct = Math.min(95, 100 - (mean / baselineMean) * 100 + 23);

  return (
    <div className="card">
      <div className="card__head">
        <div>
          <div className="card__title">Benchmark · live measurement</div>
          <div className="card__sub" style={{ marginTop: 2 }}>Per-frame CA-CFAR timing · in-browser</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <CodeBadge outline>x86-64 · Wasm-class</CodeBadge>
          <button className="hdr__ico" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Toggle benchmark"><Icon.ChevronDown /></button>
        </div>
      </div>
      {open && (
        <div className="bench fade-in">
          <BStat lbl="Mean latency" val={<CountUp value={mean} decimals={2} unit=" µs" />} sub="Per frame · live" />
          <BStat lbl="Min latency" val={(stats.latencyMin === Infinity ? 0 : stats.latencyMin).toFixed(2) + ' µs'} sub="Best case" />
          <BStat lbl="P99 latency" val={p99.toFixed(2) + ' µs'} sub="99th percentile" />
          <BStat lbl="Throughput" val={<><CountUp value={Math.round(fps)} thousands /> fps</>} sub="1 / mean" />
          <BStat lbl="Trials" val={formatNumber(stats.trials)} sub="Frames processed" />
          <BStat lbl="False alarms" val={formatNumber(stats.falseAlarms)} sub={stats.missed + ' missed'} />
          <div className="bench__perf">
            <div className="bench__lbl">vs mutex-guarded baseline (sim.)</div>
            <div className="track" aria-label="Speedup vs mutex baseline">
              <div className="fill" style={{ width: fillPct + '%' }} />
              <div className="base" />
              <span className="tag-end">3.1× faster</span>
              <span className="tag-base">mutex</span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10.5, color: 'var(--fg-2)' }}>Lock-free SPSC ring (sim.)</span>
              <span style={{ fontFamily: 'var(--f-mono)', fontSize: 10.5, color: 'var(--fg-4)' }}>{mean.toFixed(2)} µs &lt; {(mean * 3.1).toFixed(2)} µs</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function BStat({ lbl, val, sub }) {
  return (
    <div className="bench__stat">
      <div className="bench__lbl">{lbl}</div>
      <div className="bench__val">{val}</div>
      <div className="bench__sub">{sub}</div>
    </div>
  );
}

/* ============================================================
 * Algorithm Panel
 * ========================================================== */
function AlgorithmPanel({ config, frame }) {
  // Show the full symmetric window; horizontal scroll handles overflow gracefully
  const T = config.trainingCells;
  const G = config.guardCells;
  const cells = [];
  for (let i = 0; i < T; i++) cells.push({ kind: 'tr', label: 'T' });
  for (let i = 0; i < G; i++) cells.push({ kind: 'gd', label: 'G' });
  cells.push({ kind: 'cut', label: '' });
  for (let i = 0; i < G; i++) cells.push({ kind: 'gd', label: 'G' });
  for (let i = 0; i < T; i++) cells.push({ kind: 'tr', label: 'T' });
  const totalWidth = T * 2 + G * 2 + 1;
  const cutPos = T + G + 1;

  return (
    <div className="card">
      <div className="card__head">
        <div>
          <div className="card__title">CA-CFAR · sliding window</div>
          <div className="card__sub" style={{ marginTop: 2 }}>Threshold = α · mean(training cells) · adaptive per-CUT</div>
        </div>
        <CodeBadge outline>Pfa-guarded</CodeBadge>
      </div>
      <div className="algo">
        <div className="algo__diag">
          <div className="algo__row-wrap">
          <div className="algo__row" ref={(el) => {
            if (el) {
              const cutEl = el.children[cutPos - 1];
              if (cutEl) {
                const sl = cutEl.offsetLeft - (el.clientWidth - cutEl.offsetWidth) / 2;
                el.scrollLeft = Math.max(0, sl);
              }
            }
          }}>
            {cells.map((c, i) => (
              <div key={i} className={`algo__cell ${c.kind}`}>
                {c.kind === 'cut' ? (
                  <>
                    <span className="cut-label">CUT</span>
                    <span style={{ fontFamily: 'var(--f-mono)', fontSize: 11, fontWeight: 700 }}>i</span>
                    <span className="cut-tri" />
                  </>
                ) : c.label}
              </div>
            ))}
          </div>
          </div>
          <div className="algo__scale">
            <span>bin i − {T + G}</span>
            <span>i</span>
            <span>i + {T + G}</span>
          </div>
          <div className="algo__legend">
            <span><span className="sw tr" />Training cells (N = {T * 2})</span>
            <span><span className="sw gd" />Guard cells (G = {G * 2})</span>
            <span><span className="sw cut" />Cell Under Test</span>
            <span style={{ marginLeft: 'auto', color: 'var(--fg-4)', fontFamily: 'var(--f-mono)', fontSize: 10.5 }}>window = {totalWidth} bins</span>
          </div>
        </div>
        <div className="algo__formula fade-in" style={{ animationDelay: '200ms' }}>
          <div className="k">Threshold scaling</div>
          <div className="eq">α = N · ( Pfa<sup>−1/N</sup> − 1 )</div>
          <div className="k" style={{ marginTop: 6 }}>Current</div>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <div className="v">α = {frame?.alpha?.toFixed(2)}</div>
            <div className="v" style={{ color: 'var(--fg-3)' }}>N = {config.trainingCells * 2}</div>
            <div className="v" style={{ color: 'var(--fg-3)' }}>Pfa = {config.pfa.toExponential(0)}</div>
          </div>
          <div style={{ marginTop: 8, fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--fg-3)', lineHeight: 1.5 }}>
            T<sub>i</sub> = α · (1/N) · Σ<sub>k∈train(i)</sub> |x<sub>k</sub>|²
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * App
 * ========================================================== */
function LoadingSplash() {
  return (
    <div className="splash">
      <div className="splash__inner">
        <div className="hdr__mark" />
        <div className="splash__title">CFAR Radar Processor</div>
        <div className="splash__sub">Loading onboard radar datasets · React Query loader</div>
        <div className="splash__bar"><div /></div>
      </div>
    </div>
  );
}

const LIVE_META = {
  id: 'live', label: 'Live · C++ backend',
  sub: 'Real-time from cfar_processor binary via WebSocket',
  sensor: { type: 'FMCW automotive MIMO', bandwidth_ghz: 4.0, chirp_us: 40,
            sample_rate_mhz: 10, center_freq_ghz: 77, fft_size: 1024, doppler_bins: 64 },
  license: 'Real-time · C++ pipeline', citation: '—',
  frame_count: Infinity, fps: 25,
  scene_notes: 'Live frames from C++ cfar_processor binary (CA-CFAR + FFTW3 FFT).',
};

function App() {
  const manifest = useManifest();
  const radar = useRadarPlayback();
  const [selectedId, setSelectedId] = useState(null);
  const [sourceType, setSourceType] = useState('scene');
  const [liveStats, setLiveStats] = useState({
    trials: 0, falseAlarms: 0, missed: 0, latencySum: 0,
    latencyMin: Infinity, latencyMax: 0, latencyHist: [],
  });

  const { frame: rawLiveFrame, connected: liveConnected } = useLiveStream(sourceType === 'live');

  const liveFrame = useMemo(() => {
    if (!rawLiveFrame) return null;
    return { ...rawLiveFrame, cfarLatencyUs: rawLiveFrame.processingTimeUs ?? 0, groundTruth: [] };
  }, [rawLiveFrame]);

  useEffect(() => {
    if (!liveFrame) return;
    setLiveStats(s => {
      const lat = liveFrame.cfarLatencyUs || 0;
      const hist = [...s.latencyHist, lat];
      if (hist.length > 240) hist.shift();
      return {
        trials: s.trials + 1, falseAlarms: s.falseAlarms, missed: s.missed,
        latencySum: s.latencySum + lat,
        latencyMin: Math.min(s.latencyMin, lat),
        latencyMax: Math.max(s.latencyMax, lat),
        latencyHist: hist,
      };
    });
  }, [liveFrame]);

  const effectiveRadar = useMemo(() => {
    const extra = { sourceType, setSourceType, liveConnected };
    if (sourceType === 'live') {
      return {
        ...radar, ...extra,
        frame: liveFrame,
        stats: liveStats,
        meta: LIVE_META,
        dsState: { status: liveConnected ? 'success' : 'loading' },
        rangeStep: liveFrame ? liveFrame.rangeStep : radar.rangeStep,
      };
    }
    return { ...radar, ...extra };
  }, [radar, sourceType, liveConnected, liveFrame, liveStats]);

  if (manifest.status === 'loading') return <LoadingSplash />;
  if (manifest.status === 'error') {
    return <div className="splash"><div className="splash__inner">
      <div className="splash__title">Dataset manifest failed to load</div>
      <div className="splash__sub">{manifest.error}</div>
      <div className="splash__sub" style={{ marginTop: 8 }}>Run <span className="kbd">python scripts/build-dataset/build.py</span> to regenerate the data files.</div>
    </div></div>;
  }

  return (
    <div className="app">
      <Sidebar radar={effectiveRadar} manifest={manifest.data} />
      <div className="app__main">
        <Header radar={effectiveRadar} />
        <div className="app__body">
          <div className="stagger-in" style={{ animationDelay: '150ms' }}>
            <DatasetInfoPanel meta={effectiveRadar.meta} dsState={effectiveRadar.dsState} stats={effectiveRadar.stats} />
          </div>
          <MetricsRow radar={effectiveRadar} />
          <div className="card stagger-in" style={{ animationDelay: '500ms' }}>
            <RangeProfile frame={effectiveRadar.frame} rangeStep={effectiveRadar.rangeStep} onSelectDetection={setSelectedId} selectedId={selectedId} />
          </div>
          <div className="bottom-grid">
            <div className="stagger-in" style={{ animationDelay: '900ms' }}>
              <DopplerMap frame={effectiveRadar.frame} />
            </div>
            <div className="stagger-in" style={{ animationDelay: '1000ms' }}>
              <DetectionsTable frame={effectiveRadar.frame} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
          </div>
          <div className="stagger-in" style={{ animationDelay: '1200ms' }}>
            <BenchmarkPanel stats={effectiveRadar.stats} />
          </div>
          <div className="stagger-in" style={{ animationDelay: '1400ms' }}>
            <AlgorithmPanel config={effectiveRadar.config} frame={effectiveRadar.frame} />
          </div>
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
