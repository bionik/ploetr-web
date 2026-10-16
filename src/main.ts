import { Drawing } from './drawing';
import { summarizeGcode } from './gcode';
import { Plotter } from './plotter';

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

function log(text: string, cls: string): void {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = text;
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
  logEl.append(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild!.remove();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

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
  $('file-pause').textContent = s.state === 'Hold' ? 'Resume' : 'Pause';
});

plotter.on('job', (job) => {
  const progress = job ? `${job.done}/${job.total}` : '';
  if (file?.running && job) {
    $('file-result').textContent = `Running ${Math.floor((job.done / job.total) * 100)}% (${progress})`;
  } else {
    $('job').textContent = progress;
  }
  setEnabled();
});

// ---- G-code files ---------------------------------------------------------

interface LoadedFile {
  name: string;
  text: string;
  running: boolean;
  /** Set once the file has been run (or attempted). */
  ran: boolean;
}

let file: LoadedFile | null = null;
let stopRequested = false;

function renderFileBar(): void {
  $('file-bar').hidden = !file;
  if (!file) return;
  const run = $<HTMLButtonElement>('file-run');
  run.hidden = file.running;
  run.textContent = file.ran ? 'Run again' : 'Run';
  run.disabled = !plotter.connected || plotter.job !== null;
  run.title = plotter.connected ? '' : 'Connect first';
  $('file-pause').hidden = !file.running;
  $('file-clear').hidden = file.running;
  $('file-clear').textContent = file.ran ? 'Close' : 'Cancel';
}

async function loadFile(f: File): Promise<void> {
  if (plotter.job) throw new Error('Cannot load a file while a job is running');
  const text = await f.text();
  const { lines, bounds } = summarizeGcode(text);
  if (!lines) throw new Error(`${f.name} contains no G-code`);
  const r = (a: number, b: number) => `${+a.toFixed(1)}…${+b.toFixed(1)}`;
  const extent = bounds ? ` · X ${r(bounds.minX, bounds.maxX)} Y ${r(bounds.minY, bounds.maxY)} mm` : '';
  file = { name: f.name, text, running: false, ran: false };
  $('file-name').textContent = f.name;
  $('file-info').textContent = `${lines} lines${extent}`;
  $('file-result').textContent = 'Run with start and end G-code?';
  $('file-result').className = '';
  renderFileBar();
}

async function runFile(): Promise<void> {
  if (!file) return;
  const current = file;
  const started = Date.now();
  const result = $('file-result');
  result.className = '';
  current.running = true;
  stopRequested = false;
  log(`Running ${current.name}`, 'info');
  try {
    await plotter.run(current.text);
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
$('file-run').addEventListener('click', () => act(runFile));
$('file-pause').addEventListener('click', () =>
  act(() => (plotter.status?.state === 'Hold' ? plotter.resume() : plotter.pause())),
);
$('file-clear').addEventListener('click', () => {
  file = null;
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
$('home').addEventListener('click', () => act(() => plotter.home()));
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
