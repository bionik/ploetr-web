import { Drawing, type Path } from './drawing';
import { Emitter } from './emitter';
import { fmt, PenFilter, summarizeGcode, type PenState } from './gcode';
import { Grbl, REALTIME, type GrblStatus } from './grbl';

export interface PlotterConfig {
  baudRate: number;
  /**
   * Drawable area in mm, right and down from the work origin at its top-left
   * corner. In page coordinates the bed is x 0…bedWidth, y 0…bedHeight.
   */
  bedWidth: number;
  bedHeight: number;
  /** Which way machine +Y moves the pen on the page. 'up' maps page y to machine −Y. */
  yAxis: 'up' | 'down';
  /** Servo S value for pen up (0–255 with $30=255). */
  penUpValue: number;
  /** Servo S value for pen down. */
  penDownValue: number;
  /** Seconds to dwell after a pen move so the servo can settle. */
  penDelay: number;
  /** Drawing feed rate, mm/min. Travel moves use G0 (max rate). */
  drawFeed: number;
  /** Z at or below this counts as pen down when running G-code files. */
  zThreshold: number;
  /** Sent before every job. `{penUp}` / `{penDown}` expand to the pen commands. */
  startGcode: string;
  /** Sent after every job, including after a G-code error. */
  endGcode: string;
}

export const DEFAULT_CONFIG: PlotterConfig = {
  baudRate: 115200,
  bedWidth: 300,
  bedHeight: 200,
  yAxis: 'down',
  penUpValue: 0,
  penDownValue: 255,
  penDelay: 0.2,
  drawFeed: 2000,
  zThreshold: 0,
  startGcode: 'G21 ; millimetres\nG90 ; absolute\n{penUp}',
  endGcode: '{penUp}\nG0 X0 Y0\nM5 ; servo off',
};

export interface JobProgress {
  done: number;
  total: number;
}

export interface JobOptions {
  /** Send start G-code first (default true). */
  start?: boolean;
  /** Send end G-code last (default true). */
  end?: boolean;
  /** Run even if the job goes outside the bed (default false). */
  ignoreBounds?: boolean;
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type Position = { x: number; y: number };

export class BoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundsError';
  }
}

type PlotterEvents = {
  status: GrblStatus;
  connection: boolean;
  /** Running job progress; null when the job ends. */
  job: JobProgress | null;
  log: { dir: 'tx' | 'rx' | 'info' | 'error'; text: string };
};

const STORAGE_KEY = 'ploetr-web.config';
/** Max lines awaiting `ok` from the job runner; GRBL's RX buffer throttles actual writes. */
const JOB_WINDOW = 64;

/**
 * Pen plotter on GRBL-servo firmware. Z never moves: the pen is a
 * servo driven by M3 S<value>.
 *
 * The API uses page coordinates: mm from the work origin at the top-left
 * corner, x to the right, y down. They are converted to machine coordinates
 * (see `yAxis`). Raw G-code (`send`, `run`) is always machine coordinates.
 *
 *   await plotter.connect();
 *   await plotter.plot(new Drawing().circle(50, 50, 20));
 *   await plotter.run(gcodeText);
 */
export class Plotter extends Emitter<PlotterEvents> {
  readonly grbl = new Grbl();
  config: PlotterConfig = Plotter.loadConfig();
  pen: PenState = 'unknown';
  job: JobProgress | null = null;

  private penFilter = this.newPenFilter();
  private stopRequested = false;
  /** Where queued jogs will leave the pen, until a status report catches up. */
  private jogTarget: Position | null = null;
  private jogAckAt = 0;

  constructor() {
    super();
    this.grbl.on('status', (s) => {
      // Two status polls after the last jog was accepted, an Idle report is authoritative again.
      if (this.jogTarget && s.state === 'Idle' && !this.grbl.pendingCount && Date.now() - this.jogAckAt > 400) {
        this.jogTarget = null;
      }
      this.emit('status', s);
    });
    this.grbl.on('connection', (c) => {
      this.jogTarget = null;
      if (!c) this.pen = 'unknown';
      this.emit('connection', c);
    });
    this.grbl.on('tx', (t) => !this.job && this.emit('log', { dir: 'tx', text: t }));
    this.grbl.on('rx', (t) => !(this.job && t === 'ok') && this.emit('log', { dir: 'rx', text: t }));
  }

  get connected(): boolean {
    return this.grbl.connected;
  }

  get status(): GrblStatus | null {
    return this.grbl.status;
  }

  /** Current work position in page coordinates, or null before the first status report. */
  get position(): Position | null {
    const w = this.grbl.status?.wpos;
    return w ? this.toPage(w.x, w.y) : null;
  }

  /** Page (x right, y down) → machine work coordinates. */
  toMachine(x: number, y: number): Position {
    return { x, y: this.config.yAxis === 'up' ? -y : y };
  }

  /** Machine work coordinates → page coordinates. */
  toPage(x: number, y: number): Position {
    return this.toMachine(x, y); // the mapping is its own inverse
  }

  /** Converts machine-coordinate bounds (e.g. of a G-code file) to page coordinates. */
  pageBounds(machine: Bounds | null): Bounds | null {
    if (!machine) return null;
    const a = this.toPage(machine.minX, machine.minY);
    const b = this.toPage(machine.maxX, machine.maxY);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }

  // ---- connection -------------------------------------------------------

  /** Opens the port picker (call from a click handler) and waits for GRBL. */
  async connect(): Promise<void> {
    await this.grbl.connect(this.config.baudRate);
    this.penFilter = this.newPenFilter();
    this.info(`Connected: GRBL ${this.grbl.version ?? '?'}`);
  }

  disconnect(): Promise<void> {
    return this.grbl.disconnect();
  }

  // ---- config -----------------------------------------------------------

  setConfig(patch: Partial<PlotterConfig>): PlotterConfig {
    this.config = { ...this.config, ...patch };
    this.penFilter = this.newPenFilter();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch { /* storage unavailable */ }
    return this.config;
  }

  resetConfig(): PlotterConfig {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* storage unavailable */ }
    return this.setConfig(DEFAULT_CONFIG);
  }

  private static loadConfig(): PlotterConfig {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  // ---- immediate commands -----------------------------------------------

  /**
   * Sends one G-code line (or several, newline-separated). Z words are
   * turned into pen moves or removed. Resolves when GRBL has accepted it.
   */
  async send(gcode: string): Promise<void> {
    this.assertIdle();
    this.jogTarget = null;
    this.penFilter.pen = this.pen;
    const lines = gcode.split('\n').flatMap((l) => this.penFilter.filter(l));
    this.pen = this.penFilter.pen;
    await this.sendAll(lines);
  }

  async penUp(): Promise<void> {
    this.assertIdle();
    await this.sendAll(this.penCommands('up'));
    this.pen = 'up';
  }

  async penDown(): Promise<void> {
    this.assertIdle();
    await this.sendAll(this.penCommands('down'));
    this.pen = 'down';
  }

  /** Travel to (x, y) with the pen lifted. */
  async moveTo(x: number, y: number): Promise<void> {
    this.assertIdle();
    this.assertInBed({ minX: x, minY: y, maxX: x, maxY: y });
    this.jogTarget = null;
    if (this.pen !== 'up') await this.penUp();
    await this.grbl.send(`G0${this.xy(x, y)}`);
  }

  /** Draw a line to (x, y) with the pen down. */
  async lineTo(x: number, y: number, feed = this.config.drawFeed): Promise<void> {
    this.assertIdle();
    this.assertInBed({ minX: x, minY: y, maxX: x, maxY: y });
    this.jogTarget = null;
    if (this.pen !== 'down') await this.penDown();
    await this.grbl.send(`G1${this.xy(x, y)}F${fmt(feed)}`);
  }

  /** Resolves when all queued motion has physically finished. */
  idle(): Promise<void> {
    return this.grbl.synchronize();
  }

  /**
   * Relative jog in page directions (dy > 0 moves down the page). The move is
   * shortened so the pen stays on the bed. Uses $J= on GRBL 1.1, G91 moves otherwise.
   */
  async jog(dx: number, dy: number, feed = this.config.drawFeed): Promise<void> {
    this.assertIdle();
    const from = this.jogTarget ?? this.position;
    if (!from) throw new Error('Position unknown: wait for a status report');
    const { bedWidth: w, bedHeight: h } = this.config;
    // Per axis, never move further outside 0…max; moving back toward the bed is always allowed.
    const limit = (from: number, d: number, max: number) =>
      d > 0 ? Math.min(from + d, Math.max(from, max)) : d < 0 ? Math.max(from + d, Math.min(from, 0)) : from;
    const to = { x: limit(from.x, dx, w), y: limit(from.y, dy, h) };
    const step = this.toMachine(to.x - from.x, to.y - from.y);
    const axes = `${Math.abs(step.x) > 1e-6 ? `X${fmt(step.x)}` : ''}${Math.abs(step.y) > 1e-6 ? `Y${fmt(step.y)}` : ''}`;
    if (!axes) {
      this.info('At the edge of the bed');
      return;
    }
    if (to.x !== from.x + dx || to.y !== from.y + dy) this.info('Jog stopped at the edge of the bed');
    this.jogTarget = to;
    if (this.grbl.supportsJog) {
      await this.grbl.send(`$J=G21G91${axes}F${fmt(feed)}`);
    } else {
      await this.sendAll(['G91', `G1${axes}F${fmt(feed)}`, 'G90']);
    }
    this.jogAckAt = Date.now();
  }

  /** Clears an alarm lock ($X). */
  unlock(): Promise<void> {
    return this.grbl.send('$X');
  }

  /** Makes the current position the work origin (X0 Y0). */
  setOrigin(): Promise<void> {
    this.assertIdle();
    this.jogTarget = null;
    return this.grbl.send('G10L20P1X0Y0');
  }

  /** Lifts the pen and travels to the work origin. */
  goOrigin(): Promise<void> {
    return this.moveTo(0, 0);
  }

  // ---- jobs -------------------------------------------------------------

  /** Plots a Drawing (or raw paths) wrapped in start/end G-code. */
  plot(drawing: Drawing | Path[], options?: JobOptions): Promise<void> {
    const d = drawing instanceof Drawing ? drawing : new Drawing(drawing);
    if (!options?.ignoreBounds) this.assertInBed(d.bounds());
    const paths = d.paths;
    return this.runLines(this.pathsToGcode(paths), options);
  }

  /** Runs a G-code program (file contents) wrapped in start/end G-code. */
  run(gcode: string, options?: JobOptions): Promise<void> {
    if (!options?.ignoreBounds) this.assertInBed(this.pageBounds(summarizeGcode(gcode).bounds));
    const filter = this.newPenFilter();
    filter.pen = options?.start === false ? 'unknown' : 'up'; // start G-code lifts the pen
    const lines = gcode.split('\n').flatMap((l) => filter.filter(l));
    // Program end (M2/M30) would switch the servo off before the end G-code runs.
    const body = options?.end === false ? lines : lines.filter((l) => !/^M(0?2|30)$/.test(l));
    return this.runLines(body, options);
  }

  /** Converts pen paths (page coordinates) to G-code lines, without start/end G-code. */
  pathsToGcode(paths: Path[]): string[] {
    const out: string[] = [];
    const feed = fmt(this.config.drawFeed);
    for (const path of paths) {
      if (!path.length) continue;
      const [[x0, y0], ...rest] = path;
      out.push(`G0${this.xy(x0, y0)}`, ...this.penCommands('down'));
      rest.forEach(([x, y], i) => out.push(`G1${this.xy(x, y)}${i === 0 ? `F${feed}` : ''}`));
      out.push(...this.penCommands('up'));
    }
    return out;
  }

  /** Feed hold: pauses motion (the pen stays where it is). */
  pause(): Promise<void> {
    return this.grbl.feedHold();
  }

  resume(): Promise<void> {
    return this.grbl.cycleStart();
  }

  /**
   * Stops everything: drops queued lines, decelerates to a halt, soft-resets
   * (position is kept because the machine is stopped) and lifts the pen.
   */
  async stop(): Promise<void> {
    if (!this.connected) return;
    this.stopRequested = true;
    this.jogTarget = null;
    this.grbl.clearQueue('Stopped');
    const state = this.grbl.status?.state;
    if (state === 'Jog') {
      await this.grbl.realtime(REALTIME.jogCancel);
    } else if (state === 'Run' || state === 'Hold' || state === 'Queue') {
      await this.grbl.feedHold();
      await this.grbl.waitForHalt();
    }
    const ready = new Promise<void>((r) => {
      const off = this.grbl.on('ready', () => (off(), r()));
    });
    await this.grbl.softReset();
    await ready;
    this.pen = 'unknown';
    // Bypasses assertIdle: the stopped job may not have unwound yet.
    await this.sendAll(this.penCommands('up')).catch((e: Error) => this.error(e.message));
    this.pen = 'up';
    this.info('Stopped');
  }

  private async runLines(body: string[], { start = true, end = true }: JobOptions = {}): Promise<void> {
    this.assertIdle();
    this.stopRequested = false;
    this.jogTarget = null;
    const lines = [
      ...(start ? this.expand(this.config.startGcode) : []),
      ...body,
    ];
    const job: JobProgress = { done: 0, total: lines.length + (end ? this.expand(this.config.endGcode).length : 0) };
    this.job = job;
    this.emit('job', { ...job });
    this.info(`Job started: ${job.total} lines`);
    try {
      await this.stream(lines, job);
      if (end) await this.stream(this.expand(this.config.endGcode), job);
      await this.grbl.synchronize();
      this.info('Job finished');
    } catch (e) {
      if (!this.stopRequested && end && this.connected && !this.grbl.status?.state.startsWith('Alarm')) {
        // On a G-code error, still lift the pen and park via the end G-code.
        this.error(`${(e as Error).message}. Running end G-code.`);
        await this.stream(this.expand(this.config.endGcode), job).catch(() => {});
      }
      throw e;
    } finally {
      this.job = null;
      this.pen = 'unknown';
      this.emit('job', null);
    }
  }

  private async stream(lines: string[], job: JobProgress): Promise<void> {
    const window: Promise<void>[] = [];
    let failure: Error | null = null;
    for (const line of lines) {
      if (failure) break;
      const p = this.grbl.send(line).then(() => {
        job.done++;
        this.emit('job', { ...job });
      });
      p.catch((e: Error) => {
        if (failure) return;
        failure = e;
        this.grbl.clearQueue(e.message);
      });
      window.push(p);
      if (window.length >= JOB_WINDOW) await window.shift()!.catch(() => {});
    }
    await Promise.allSettled(window);
    if (failure) throw failure;
  }

  // ---- helpers ----------------------------------------------------------

  /** Machine X/Y words for a page point. */
  private xy(x: number, y: number): string {
    const m = this.toMachine(x, y);
    return `X${fmt(m.x)}Y${fmt(m.y)}`;
  }

  private penCommands(state: 'up' | 'down'): string[] {
    const value = state === 'up' ? this.config.penUpValue : this.config.penDownValue;
    return [`M3S${value}`, `G4P${fmt(this.config.penDelay)}`];
  }

  /** Splits start/end G-code into lines, expanding {penUp}/{penDown}, filtering Z. */
  private expand(gcode: string): string[] {
    const filter = this.newPenFilter();
    return gcode
      .replace(/\{penUp\}/g, this.penCommands('up').join('\n'))
      .replace(/\{penDown\}/g, this.penCommands('down').join('\n'))
      .split('\n')
      .flatMap((l) => filter.filter(l));
  }

  private newPenFilter(): PenFilter {
    return new PenFilter({
      zThreshold: this.config.zThreshold,
      penUp: this.penCommands('up'),
      penDown: this.penCommands('down'),
    });
  }

  private sendAll(lines: string[]): Promise<void> {
    return Promise.all(lines.map((l) => this.grbl.send(l))).then(() => {});
  }

  /** Describes how `bounds` (page coordinates) exceeds the bed, or returns null if it fits. */
  outOfBounds(bounds: Bounds | null): string | null {
    if (!bounds) return null;
    const { bedWidth: w, bedHeight: h } = this.config;
    const eps = 1e-6;
    const issues: string[] = [];
    if (bounds.minX < -eps) issues.push(`X ${fmt(bounds.minX)} < 0`);
    if (bounds.maxX > w + eps) issues.push(`X ${fmt(bounds.maxX)} > ${fmt(w)}`);
    if (bounds.minY < -eps) issues.push(`Y ${fmt(bounds.minY)} < 0`);
    if (bounds.maxY > h + eps) issues.push(`Y ${fmt(bounds.maxY)} > ${fmt(h)}`);
    return issues.length ? `Outside bed: ${issues.join(', ')}` : null;
  }

  private assertInBed(bounds: Bounds | null): void {
    const problem = this.outOfBounds(bounds);
    if (problem) throw new BoundsError(problem);
  }

  private assertIdle(): void {
    if (!this.connected) throw new Error('Not connected');
    if (this.job) throw new Error('A job is running');
  }

  private info(text: string): void {
    this.emit('log', { dir: 'info', text });
  }

  private error(text: string): void {
    this.emit('log', { dir: 'error', text });
  }
}
