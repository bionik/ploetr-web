import { Grbl } from './grbl';

export type PenState = 'up' | 'down' | 'unknown';

export interface PenFilterOptions {
  /** Z at or below this value means pen down. */
  zThreshold: number;
  penUp: string[];
  penDown: string[];
}

/**
 * Removes Z from G-code so the Z axis never moves. Z moves in motion
 * lines become pen up/down commands; Z words in other commands are dropped.
 * Stateful: feed it lines in order.
 */
export class PenFilter {
  pen: PenState = 'unknown';
  private z: number | null = null;
  private relative = false;

  constructor(private opts: PenFilterOptions) {}

  /** Returns zero or more cleaned lines to send in place of `line`. */
  filter(line: string): string[] {
    const clean = Grbl.clean(line).replace(/^N\d+/, '');
    if (!clean || clean === '%') return [];

    // Track the distance mode so relative Z moves are interpreted correctly.
    const g = [...clean.matchAll(/G(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    if (g.includes(90)) this.relative = false;
    if (g.includes(91)) this.relative = true;

    // Track pen state when the file drives the servo itself.
    if (/M0?3(?!\d)/.test(clean) || /M0?5(?!\d)/.test(clean)) this.pen = 'unknown';

    const zMatch = clean.match(/Z([-+]?\d*\.?\d+)/);
    if (!zMatch) return [clean];

    const rest = clean.replace(zMatch[0], '');
    const hasXY = /[XY]/.test(rest);
    const out: string[] = [];

    if (clean.startsWith('$')) {
      // e.g. "$J=G91Z5F500": keep the XY part, or drop it when nothing is left.
      return hasXY ? [rest] : [];
    }
    if (/G(28|30|53|10|92)(?![\d.])/.test(clean)) {
      // Z only in a homing/offset command: dropping Z would change its meaning (e.g. G28 → all axes).
      return hasXY ? [rest] : [];
    }

    const value = Number(zMatch[1]);
    this.z = this.relative ? (this.z ?? 0) + value : value;
    const want: PenState = this.z <= this.opts.zThreshold ? 'down' : 'up';
    if (want !== this.pen) {
      out.push(...(want === 'down' ? this.opts.penDown : this.opts.penUp));
      this.pen = want;
    }

    // A bare "G1" or "G1F300" left over from a Z-only move: keep only the feed rate.
    const bare = rest.match(/^(?:G0?[01](?![\d.]))?(F[\d.]+)?$/);
    if (bare) {
      if (bare[1]) out.push(bare[1]);
    } else {
      out.push(rest);
    }
    return out;
  }
}

export interface GcodeSummary {
  lines: number;
  /** XY extents of G0/G1/G2/G3 end points, or null if the program has no XY moves. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/** Counts executable lines and estimates XY extents (arc bulges are ignored). */
export function summarizeGcode(text: string): GcodeSummary {
  let lines = 0;
  let relative = false;
  let x = 0;
  let y = 0;
  let bounds: GcodeSummary['bounds'] = null;
  for (const raw of text.split('\n')) {
    const line = Grbl.clean(raw).replace(/^N\d+/, '');
    if (!line || line === '%') continue;
    lines++;
    if (line.startsWith('$')) continue;
    if (/G90(?![\d.])/.test(line)) relative = false;
    if (/G91(?![\d.])/.test(line)) relative = true;
    if (/G(28|30|53|10|92)(?![\d.])/.test(line)) continue;
    const mx = line.match(/X([-+]?\d*\.?\d+)/);
    const my = line.match(/Y([-+]?\d*\.?\d+)/);
    if (!mx && !my) continue;
    if (mx) x = relative ? x + Number(mx[1]) : Number(mx[1]);
    if (my) y = relative ? y + Number(my[1]) : Number(my[1]);
    bounds ??= { minX: x, minY: y, maxX: x, maxY: y };
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  return { lines, bounds };
}

export function fmt(n: number): string {
  return Number(n.toFixed(3)).toString();
}
