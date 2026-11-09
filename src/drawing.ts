export type Point = [x: number, y: number];
export type Path = Point[];

/**
 * Collects pen paths in machine millimetres. Every `moveTo` starts a new
 * pen-down stroke; `lineTo` extends the current one.
 *
 *   const d = new Drawing().rect(10, 10, 50, 30).circle(35, 25, 10);
 *   await plotter.plot(d);
 */
export class Drawing {
  private current: Path | null = null;

  constructor(readonly paths: Path[] = []) {}

  moveTo(x: number, y: number): this {
    this.current = [[x, y]];
    this.paths.push(this.current);
    return this;
  }

  lineTo(x: number, y: number): this {
    if (!this.current) return this.moveTo(x, y);
    this.current.push([x, y]);
    return this;
  }

  /** Draws through the points; `closed` returns to the first point. */
  polyline(points: Point[], closed = false): this {
    if (!points.length) return this;
    this.moveTo(...points[0]);
    for (const p of points.slice(1)) this.lineTo(...p);
    if (closed) this.lineTo(...points[0]);
    return this;
  }

  rect(x: number, y: number, w: number, h: number): this {
    return this.polyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
  }

  /** Circle approximated by line segments; default keeps segments around 1 mm. */
  circle(cx: number, cy: number, r: number, segments = Math.max(16, Math.ceil(2 * Math.PI * r))): this {
    return this.arc(cx, cy, r, 0, 2 * Math.PI, segments);
  }

  /**
   * Arc from `start` to `end` in radians. Angle 0 points right (+X); with Y pointing
   * down the page, increasing angles turn clockwise as seen on paper.
   */
  arc(cx: number, cy: number, r: number, start: number, end: number,
      segments = Math.max(4, Math.ceil(Math.abs(end - start) * r))): this {
    const pts: Point[] = [];
    for (let i = 0; i <= segments; i++) {
      const a = start + ((end - start) * i) / segments;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return this.polyline(pts);
  }

  /** Bounding box of all points, or null if empty. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let b = null;
    for (const path of this.paths) {
      for (const [x, y] of path) {
        b ??= { minX: x, minY: y, maxX: x, maxY: y };
        b.minX = Math.min(b.minX, x);
        b.minY = Math.min(b.minY, y);
        b.maxX = Math.max(b.maxX, x);
        b.maxY = Math.max(b.maxY, y);
      }
    }
    return b;
  }
}
