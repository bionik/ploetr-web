import { Drawing } from './drawing';
import { summarizeGcode } from './gcode';
import { DEFAULT_CONFIG, Plotter, type Bounds, type JobOptions, type PlotterConfig } from './plotter';

const plotter = new Plotter();

// Scripting API, usable from the devtools console:
//   await plotter.plot(new Drawing().circle(50, 50, 20))
declare global {
  interface Window {
    plotter: Plotter;
    Drawing: typeof Drawing;
  }
}
window.plotter = plotter;
window.Drawing = Drawing;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>('log');
const feedEl = $<HTMLInputElement>('feed');
const stepEl = $<HTMLSelectElement>('step');
const cmdEl = $<HTMLInputElement>('cmd');

const MAX_LOG_LINES = 500;

/** localStorage that never throws (private windows, blocked storage). */
const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch { /* not persisted */ }
  },
};

function log(text: string, cls: string): void {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
  logEl.append(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild!.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

/** GRBL 0.9 reports a completed feed hold as Queue, 1.1 as Hold. */
const isPaused = (state?: string) => state === 'Hold' || state === 'Queue';

/** Runs a UI action, logging failures instead of throwing. */
function act(fn: () => Promise<unknown>): void {
  fn().catch((e: Error) => log(e.message, 'error'));
}

function setEnabled(): void {
  const busy = plotter.job !== null;
  document.querySelectorAll<HTMLButtonElement>('.controls button, #cmd-form button').forEach((b) => {
    b.disabled = !plotter.connected || busy;
  });
  $<HTMLButtonElement>('open').disabled = busy;
  $<HTMLButtonElement>('stop').disabled = !plotter.connected;
  $<HTMLButtonElement>('connect').textContent = plotter.connected ? 'Disconnect' : 'Connect';
  renderFileBar();
}

// ---- plotter events -------------------------------------------------------

plotter.on('log', ({ dir, text }) => log(dir === 'tx' ? `> ${text}` : text, dir));

plotter.on('connection', (connected) => {
  if (!connected) {
    $('state').textContent = 'Offline';
    $('state').dataset.state = '';
    $('pos').textContent = 'X — Y —';
    log('Disconnected', 'info');
  }
  setEnabled();
});

plotter.on('status', (s) => {
  $('state').textContent = s.subState !== null ? `${s.state}:${s.subState}` : s.state;
  $('state').dataset.state = s.state;
  if (s.wpos) $('pos').textContent = `X ${s.wpos.x.toFixed(2)} Y ${s.wpos.y.toFixed(2)}`;
  $('pen').textContent = `pen ${plotter.pen === 'unknown' ? '—' : plotter.pen}`;
  $('file-pause').textContent = isPaused(s.state) ? 'Resume' : 'Pause';
});

plotter.on('job', (job) => {
  const progress = job ? `${job.done}/${job.total}` : '';
  if (loaded?.running && job) {
    $('file-result').textContent = `Running ${Math.floor((job.done / job.total) * 100)}% (${progress})`;
  } else {
    $('job').textContent = progress;
  }
  setEnabled();
});

// ---- loaded jobs (G-code files and scripts) --------------------------------

interface LoadedJob {
  name: string;
  info: string;
  bounds: Bounds | null;
  run: (options: JobOptions) => Promise<void>;
  running: boolean;
  /** Set once the job has been run (or attempted). */
  ran: boolean;
}

let loaded: LoadedJob | null = null;
let stopRequested = false;

const range = (a: number, b: number) => `${+a.toFixed(1)}…${+b.toFixed(1)}`;
const extent = (b: Bounds | null) => (b ? ` · X ${range(b.minX, b.maxX)} Y ${range(b.minY, b.maxY)} mm` : '');

function renderFileBar(): void {
  $('file-bar').hidden = !loaded;
  if (!loaded) return;
  const outside = plotter.outOfBounds(loaded.bounds);
  const result = $('file-result');
  if (!loaded.running && !loaded.ran) {
    result.textContent = outside ? `⚠ ${outside}` : 'Run with start and end G-code?';
    result.className = outside ? 'warn' : '';
  }
  const run = $<HTMLButtonElement>('file-run');
  run.hidden = loaded.running;
  run.textContent = `${loaded.ran ? 'Run again' : 'Run'}${outside ? ' anyway' : ''}`;
  run.classList.toggle('primary', !outside);
  run.disabled = !plotter.connected || plotter.job !== null;
  run.title = plotter.connected ? '' : 'Connect first';
  $('file-pause').hidden = !loaded.running;
  $('file-clear').hidden = loaded.running;
  $('file-clear').textContent = loaded.ran ? 'Close' : 'Cancel';
}

function load(job: Omit<LoadedJob, 'running' | 'ran'>): void {
  if (plotter.job) throw new Error('Cannot load while a job is running');
  loaded = { ...job, running: false, ran: false };
  $('file-name').textContent = job.name;
  $('file-info').textContent = job.info;
  renderFileBar();
}

async function loadFile(f: File): Promise<void> {
  const text = await f.text();
  const { lines, bounds } = summarizeGcode(text);
  if (!lines) throw new Error(`${f.name} contains no G-code`);
  load({
    name: f.name,
    info: `${lines} lines${extent(bounds)}`,
    bounds,
    run: (options) => plotter.run(text, options),
  });
}

async function runLoaded(): Promise<void> {
  if (!loaded) return;
  const current = loaded;
  const started = Date.now();
  const result = $('file-result');
  // Pressing "Run anyway" is the confirmation to ignore the bed size.
  const ignoreBounds = plotter.outOfBounds(current.bounds) !== null;
  result.className = '';
  current.running = true;
  stopRequested = false;
  log(`Running ${current.name}`, 'info');
  try {
    await current.run({ ignoreBounds });
    const s = Math.round((Date.now() - started) / 1000);
    result.textContent = `✓ Finished in ${Math.floor(s / 60)}m ${s % 60}s`;
    result.className = 'ok';
    log(`${current.name} finished`, 'info');
  } catch (e) {
    result.textContent = stopRequested ? 'Stopped' : `Failed: ${(e as Error).message}`;
    result.className = 'error';
  } finally {
    current.running = false;
    current.ran = true;
    renderFileBar();
  }
}

// ---- script ---------------------------------------------------------------

const SCRIPT_KEY = 'ploetr-web.script';
const DEFAULT_SCRIPT = `// d is an empty Drawing (mm from the work origin), plotter is the API.
// "Build drawing" loads the result into the bar above; Run plots it.
// Returning a Drawing uses that instead of d.

d.rect(10, 10, 80, 60);
d.circle(50, 40, 20);
for (let i = 1; i < 6; i++) d.moveTo(10, 10 + i * 10).lineTo(90, 10 + i * 10);
`;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

const scriptEl = $<HTMLTextAreaElement>('script');
scriptEl.value = storage.get(SCRIPT_KEY) ?? DEFAULT_SCRIPT;
scriptEl.addEventListener('input', () => storage.set(SCRIPT_KEY, scriptEl.value));

async function buildScript(): Promise<void> {
  const errorEl = $('script-error');
  errorEl.textContent = '';
  try {
    const d = new Drawing();
    const result = await new AsyncFunction('d', 'plotter', 'Drawing', scriptEl.value)(d, plotter, Drawing);
    const drawing = result instanceof Drawing ? result : d;
    const points = drawing.paths.reduce((n, p) => n + p.length, 0);
    if (!points) throw new Error('The script drew nothing');
    const bounds = drawing.bounds();
    load({
      name: 'Script',
      info: `${drawing.paths.length} paths, ${points} points${extent(bounds)}`,
      bounds,
      run: (options) => plotter.plot(drawing, options),
    });
  } catch (e) {
    errorEl.textContent = (e as Error).message;
  }
}

$('script-run').addEventListener('click', () => void buildScript());
scriptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void buildScript();
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    document.execCommand('insertText', false, '  ');
  }
});

// ---- tabs -----------------------------------------------------------------

const TAB_KEY = 'ploetr-web.tab';
function showTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
    $(`tab-${b.dataset.tab}`).hidden = b.dataset.tab !== name;
  });
  storage.set(TAB_KEY, name);
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab!)),
);
showTab(storage.get(TAB_KEY) === 'script' ? 'script' : 'console');

// ---- settings -------------------------------------------------------------

const settingsEl = $<HTMLDialogElement>('settings');
const settingFields = settingsEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-key]');

function fillSettings(config: PlotterConfig): void {
  settingFields.forEach((el) => (el.value = String(config[el.dataset.key as keyof PlotterConfig])));
}

$('settings-open').addEventListener('click', () => {
  fillSettings(plotter.config);
  settingsEl.showModal();
});
$('settings-reset').addEventListener('click', () => fillSettings(DEFAULT_CONFIG));
settingsEl.addEventListener('close', () => {
  if (settingsEl.returnValue !== 'save') return;
  const patch: Record<string, string | number> = {};
  settingFields.forEach((el) => {
    patch[el.dataset.key!] = el instanceof HTMLTextAreaElement ? el.value : Number(el.value);
  });
  plotter.setConfig(patch as Partial<PlotterConfig>);
  feedEl.value = String(plotter.config.drawFeed);
  renderFileBar();
  log('Settings saved', 'info');
});
settingsEl.querySelectorAll<HTMLButtonElement>('[data-test]').forEach((b) => {
  const input = settingsEl.querySelector<HTMLInputElement>(`[data-key="${b.dataset.test}"]`)!;
  b.addEventListener('click', () => act(() => plotter.send(`M3 S${Number(input.value)}`)));
});

// ---- controls -------------------------------------------------------------

$('connect').addEventListener('click', () =>
  act(() => (plotter.connected ? plotter.disconnect() : plotter.connect())),
);
$('stop').addEventListener('click', () => {
  stopRequested = true;
  act(() => plotter.stop());
});

const fileInput = $<HTMLInputElement>('file-input');
$('open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (f) act(() => loadFile(f));
});
$('file-run').addEventListener('click', () => act(runLoaded));
$('file-pause').addEventListener('click', () =>
  act(() => (isPaused(plotter.status?.state) ? plotter.resume() : plotter.pause())),
);
$('file-clear').addEventListener('click', () => {
  loaded = null;
  renderFileBar();
});

// Drop a file anywhere on the page.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dropping');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const f = e.dataTransfer?.files[0];
  if (f) act(() => loadFile(f));
});

document.querySelectorAll<HTMLButtonElement>('[data-jog]').forEach((b) => {
  const [dx, dy] = b.dataset.jog!.split(',').map(Number);
  b.addEventListener('click', () => {
    const step = Number(stepEl.value);
    act(() => plotter.jog(dx * step, dy * step, Number(feedEl.value)));
  });
});

feedEl.value = String(plotter.config.drawFeed);
feedEl.addEventListener('change', () => plotter.setConfig({ drawFeed: Number(feedEl.value) }));

$('origin').addEventListener('click', () => act(() => plotter.goOrigin()));
$('pen-up').addEventListener('click', () => act(() => plotter.penUp()));
$('pen-down').addEventListener('click', () => act(() => plotter.penDown()));
$('unlock').addEventListener('click', () => act(() => plotter.unlock()));
$('set-origin').addEventListener('click', () => act(() => plotter.setOrigin()));

$('cmd-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cmd = cmdEl.value.trim();
  if (!cmd) return;
  cmdEl.value = '';
  act(() => plotter.send(cmd));
});

if (!('serial' in navigator)) log('Web Serial is not available. Use Chrome or Edge over https or localhost.', 'error');
setEnabled();
