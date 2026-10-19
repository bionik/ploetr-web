import { Emitter } from './emitter';
import { SerialTransport } from './serial';

/** GRBL's serial RX buffer is 128 bytes; keep one byte of headroom. */
const RX_BUFFER_SIZE = 127;
const STATUS_INTERVAL_MS = 200;
const BANNER_TIMEOUT_MS = 2500;

export const REALTIME = {
  status: 0x3f, // '?'
  cycleStart: 0x7e, // '~'
  feedHold: 0x21, // '!'
  softReset: 0x18,
  jogCancel: 0x85, // GRBL 1.1 only
} as const;

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface GrblStatus {
  /** Idle, Run, Hold, Jog, Alarm, Door, Check, Home, Sleep. */
  state: string;
  /** Sub-state, e.g. Hold:0 = hold complete, Hold:1 = decelerating. */
  subState: number | null;
  mpos: Position | null;
  wpos: Position | null;
  feed: number | null;
  raw: string;
}

export class GrblError extends Error {
  constructor(message: string, readonly line: string, readonly code: string) {
    super(message);
    this.name = 'GrblError';
  }
}

type GrblEvents = {
  /** Every line written to the controller. */
  tx: string;
  /** Every line received, except status reports. */
  rx: string;
  status: GrblStatus;
  /** Controller (re)booted; payload is the banner line. */
  ready: string;
  alarm: string;
  connection: boolean;
};

interface Pending {
  line: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * GRBL protocol: character-counting streaming, real-time commands
 * and status polling on top of a serial transport.
 */
export class Grbl extends Emitter<GrblEvents> {
  readonly transport = new SerialTransport();
  /** Banner version string, e.g. "1.1f" (null until the banner is seen). */
  version: string | null = null;
  status: GrblStatus | null = null;

  private queue: Pending[] = [];
  private inFlight: Pending[] = [];
  private inFlightBytes = 0;
  private wco: Position = { x: 0, y: 0, z: 0 };
  private poll: ReturnType<typeof setInterval> | null = null;
  private bannerWaiters: ((banner: string) => void)[] = [];

  constructor() {
    super();
    this.transport.on('line', (line) => this.handleLine(line));
    this.transport.on('close', () => this.handleClose());
  }

  get connected(): boolean {
    return this.transport.isOpen;
  }

  /** True when GRBL supports `$J=` jogging and the 0x85 jog cancel (v1.1+). */
  get supportsJog(): boolean {
    return this.version !== null && parseFloat(this.version) >= 1.1;
  }

  async connect(baudRate: number): Promise<void> {
    await this.transport.open(baudRate);
    this.emit('connection', true);
    // Opening the port usually resets an Arduino; if no banner arrives, ask for one.
    const banner = this.waitForBanner(BANNER_TIMEOUT_MS);
    if (!(await banner)) {
      await this.softReset();
      if (!(await this.waitForBanner(BANNER_TIMEOUT_MS))) {
        await this.disconnect();
        throw new Error('No GRBL banner received. Check the baud rate and port.');
      }
    }
    this.poll = setInterval(() => void this.realtime(REALTIME.status).catch(() => {}), STATUS_INTERVAL_MS);
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
  }

  /**
   * Queues a line. Resolves when GRBL replies `ok`, rejects with GrblError on `error:N`.
   * Note that `ok` means "parsed and planned", not "motion finished" (see `synchronize`).
   */
  send(line: string): Promise<void> {
    const clean = Grbl.clean(line);
    if (!clean) return Promise.resolve();
    if (clean.length + 1 > RX_BUFFER_SIZE) return Promise.reject(new Error(`Line too long: ${clean}`));
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve, reject) => {
      this.queue.push({ line: clean, resolve, reject });
      this.pump();
    });
  }

  /** Resolves once all queued motion has completed (G4 P0 blocks until the planner is empty). */
  synchronize(): Promise<void> {
    return this.send('G4P0');
  }

  /** Number of lines queued or awaiting `ok`. */
  get pendingCount(): number {
    return this.queue.length + this.inFlight.length;
  }

  /** Rejects every line not yet written to the controller. */
  clearQueue(reason = 'Cancelled'): void {
    const dropped = this.queue;
    this.queue = [];
    dropped.forEach((p) => p.reject(new Error(reason)));
  }

  realtime(byte: number): Promise<void> {
    return this.transport.writeBytes(byte);
  }

  feedHold = () => this.realtime(REALTIME.feedHold);
  cycleStart = () => this.realtime(REALTIME.cycleStart);

  /** Soft reset: aborts everything. GRBL keeps its position only if the machine was stopped. */
  softReset(): Promise<void> {
    this.clearQueue('Reset');
    return this.realtime(REALTIME.softReset);
  }

  /** Waits until a status report satisfies `predicate`. */
  waitForStatus(predicate: (s: GrblStatus) => boolean, timeoutMs = 30000): Promise<GrblStatus> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('Timed out waiting for status'));
      }, timeoutMs);
      const off = this.on('status', (s) => {
        if (!predicate(s)) return;
        clearTimeout(timer);
        off();
        resolve(s);
      });
    });
  }

  /**
   * Resolves once a feed hold has brought the machine to rest. GRBL 1.1 reports
   * Hold:0; GRBL 0.9 has no sub-state, so wait until two reports show the same position.
   */
  waitForHalt(timeoutMs = 10000): Promise<GrblStatus> {
    let last: Position | null = null;
    return this.waitForStatus((s) => {
      if (s.state === 'Idle' || (s.state === 'Hold' && s.subState === 0)) return true;
      const still = !!last && !!s.mpos && s.mpos.x === last.x && s.mpos.y === last.y;
      last = s.mpos;
      return (s.state === 'Hold' || s.state === 'Queue') && s.subState === null && still;
    }, timeoutMs);
  }

  /** Strips comments and whitespace; GRBL ignores spaces and this saves RX buffer. */
  static clean(line: string): string {
    return line
      .replace(/\(.*?\)/g, '')
      .replace(/;.*$/, '')
      .replace(/\s+/g, '')
      .toUpperCase();
  }

  private pump(): void {
    while (this.queue.length) {
      const next = this.queue[0];
      const bytes = next.line.length + 1;
      if (this.inFlightBytes + bytes > RX_BUFFER_SIZE) break;
      this.queue.shift();
      this.inFlight.push(next);
      this.inFlightBytes += bytes;
      this.emit('tx', next.line);
      this.transport.write(next.line + '\n').catch((err: Error) => this.failAll(err));
    }
  }

  private handleLine(line: string): void {
    if (line.startsWith('<')) {
      this.handleStatus(line);
      return;
    }
    this.emit('rx', line);

    if (line === 'ok' || line.startsWith('error')) {
      const done = this.inFlight.shift();
      if (!done) return;
      this.inFlightBytes -= done.line.length + 1;
      if (line === 'ok') done.resolve();
      else done.reject(new GrblError(`${line} (${done.line})`, done.line, line.slice(6)));
      this.pump();
    } else if (/Grbl\s+\d/i.test(line)) {
      // Matched anywhere: bootloader noise can precede the banner on the same line.
      // Controller (re)booted: everything in flight was discarded.
      this.version = line.match(/Grbl\s+([\d.]+\w*)/i)?.[1] ?? null;
      this.failAll(new Error('GRBL reset'));
      this.bannerWaiters.splice(0).forEach((fn) => fn(line));
      this.emit('ready', line);
    } else if (line.startsWith('ALARM')) {
      this.emit('alarm', line);
    }
  }

  private handleStatus(raw: string): void {
    // GRBL 1.1: <Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:...>
    // GRBL 0.9: <Idle,MPos:0.000,0.000,0.000,WPos:0.000,0.000,0.000>
    const body = raw.slice(1, raw.lastIndexOf('>'));
    const v11 = body.includes('|');
    const fields = v11 ? body.split('|') : body.split(/,(?=[A-Za-z])/);
    const [state, sub] = fields[0].split(':');
    const status: GrblStatus = { state, subState: sub ? Number(sub) : null, mpos: null, wpos: null, feed: null, raw };

    for (const f of fields.slice(1)) {
      const [key, value] = f.split(':');
      const nums = value?.split(',').map(Number) ?? [];
      const pos = (): Position => ({ x: nums[0] ?? 0, y: nums[1] ?? 0, z: nums[2] ?? 0 });
      if (key === 'MPos') status.mpos = pos();
      else if (key === 'WPos') status.wpos = pos();
      else if (key === 'WCO') this.wco = pos();
      else if (key === 'FS' || key === 'F') status.feed = nums[0];
    }
    if (status.mpos && !status.wpos) {
      const { x, y, z } = status.mpos;
      status.wpos = { x: x - this.wco.x, y: y - this.wco.y, z: z - this.wco.z };
    } else if (status.wpos && !status.mpos) {
      const { x, y, z } = status.wpos;
      status.mpos = { x: x + this.wco.x, y: y + this.wco.y, z: z + this.wco.z };
    }
    this.status = status;
    this.emit('status', status);
  }

  private waitForBanner(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const fn = (banner: string) => {
        clearTimeout(timer);
        resolve(banner);
      };
      const timer = setTimeout(() => {
        this.bannerWaiters = this.bannerWaiters.filter((w) => w !== fn);
        resolve(null);
      }, timeoutMs);
      this.bannerWaiters.push(fn);
    });
  }

  private failAll(err: Error): void {
    const all = [...this.inFlight, ...this.queue];
    this.inFlight = [];
    this.queue = [];
    this.inFlightBytes = 0;
    all.forEach((p) => p.reject(err));
  }

  private handleClose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.version = null;
    this.status = null;
    this.failAll(new Error('Disconnected'));
    this.emit('connection', false);
  }
}
