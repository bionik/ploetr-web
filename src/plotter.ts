import { Drawing, type Path } from './drawing';
import { Emitter } from './emitter';
import { fmt, PenFilter, type PenState } from './gcode';
import { Grbl, REALTIME, type GrblStatus } from './grbl';

export interface PlotterConfig {
  baudRate: number;
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

  constructor() {
    super();
    this.grbl.on('status', (s) => this.emit('status', s));
    this.grbl.on('connection', (c) => {
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
    if (this.pen !== 'up') await this.penUp();
    await this.grbl.send(`G0X${fmt(x)}Y${fmt(y)}`);
  }

  /** Draw a line to (x, y) with the pen down. */
  async lineTo(x: number, y: number, feed = this.config.drawFeed): Promise<void> {
    this.assertIdle();
    if (this.pen !== 'down') await this.penDown();
    await this.grbl.send(`G1X${fmt(x)}Y${fmt(y)}F${fmt(feed)}`);
  }

  /** Resolves when all queued motion has physically finished. */
  idle(): Promise<void> {
    return this.grbl.synchronize();
  }

  /** Relative XY jog. Uses $J= on GRBL 1.1 (cancellable), plain G91 moves otherwise. */
  async jog(dx: number, dy: number, feed = this.config.drawFeed): Promise<void> {
    this.assertIdle();
    const axes = `${dx ? `X${fmt(dx)}` : ''}${dy ? `Y${fmt(dy)}` : ''}`;
    if (!axes) return;
    if (this.grbl.supportsJog) {
      await this.grbl.send(`$J=G21G91${axes}F${fmt(feed)}`);
    } else {
      await this.sendAll(['G91', `G1${axes}F${fmt(feed)}`, 'G90']);
    }
  }

  /** Runs the homing cycle ($H). Needs homing enabled ($22=1). */
  home(): Promise<void> {
    this.assertIdle();
    return this.grbl.send('$H');
  }

  /** Clears an alarm lock ($X). */
  unlock(): Promise<void> {
    return this.grbl.send('$X');
  }

  /** Makes the current position the work origin (X0 Y0). */
  setOrigin(): Promise<void> {
    this.assertIdle();
    return this.grbl.send('G10L20P1X0Y0');
  }

  /** Lifts the pen and travels to the work origin. */
  goOrigin(): Promise<void> {
    return this.moveTo(0, 0);
  }

  // ---- jobs -------------------------------------------------------------

  /** Plots a Drawing (or raw paths) wrapped in start/end G-code. */
  plot(drawing: Drawing | Path[], options?: JobOptions): Promise<void> {
    const paths = drawing instanceof Drawing ? drawing.paths : drawing;
    return this.runLines(this.pathsToGcode(paths), options);
  }

  /** Runs a G-code program (file contents) wrapped in start/end G-code. */
  run(gcode: string, options?: JobOptions): Promise<void> {
    const filter = this.newPenFilter();
    filter.pen = options?.start === false ? 'unknown' : 'up'; // start G-code lifts the pen
    const lines = gcode.split('\n').flatMap((l) => filter.filter(l));
    // Program end (M2/M30) would switch the servo off before the end G-code runs.
    const body = options?.end === false ? lines : lines.filter((l) => !/^M(0?2|30)$/.test(l));
    return this.runLines(body, options);
  }

  /** Converts pen paths to G-code lines (without start/end G-code). */
  pathsToGcode(paths: Path[]): string[] {
    const out: string[] = [];
    const feed = fmt(this.config.drawFeed);
    for (const path of paths) {
      if (!path.length) continue;
      const [[x0, y0], ...rest] = path;
      out.push(`G0X${fmt(x0)}Y${fmt(y0)}`, ...this.penCommands('down'));
      rest.forEach(([x, y], i) => out.push(`G1X${fmt(x)}Y${fmt(y)}${i === 0 ? `F${feed}` : ''}`));
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
    this.grbl.clearQueue('Stopped');
    const state = this.grbl.status?.state;
    if (state === 'Jog') {
      await this.grbl.realtime(REALTIME.jogCancel);
    } else if (state === 'Run' || state === 'Hold') {
      await this.grbl.feedHold();
      await this.grbl.waitForStatus((s) => (s.state === 'Hold' && s.subState === 0) || s.state === 'Idle', 10000);
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
