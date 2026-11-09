# plötr.

Browser controller for a pen plotter running [grbl-servo](https://github.com/cprezzi/grbl-servo), over Web Serial (Chrome/Edge, on localhost or https).

```bash
npm install
npm run dev
```

## Running G-code files

Drop a file anywhere on the page, or use **Open G-code…**. The bar that appears shows the line count and XY extents. Press **Run** to confirm: the start G-code runs first, then the file, then the end G-code. The bar then shows *Finished*, *Stopped* or *Failed*. `M2`/`M30` in the file are dropped because the end G-code finishes the program. If a line errors, the end G-code still runs to lift the pen and park.

## Settings

**Settings** in the header edits the bed size, servo S values (with **Test** buttons to try them on the machine), pen delay, draw feed, Z threshold, baud rate and start/end G-code. Settings are saved in localStorage.

## Coordinates

The origin (X0 Y0) is the top-left corner of the drawing area. X goes right and Y goes down, which is also the machine's own +Y direction, so scripts, G-code and GRBL all use the same numbers without conversion. The jog pad's ↑ sends −Y. Arc angles start at +X and increase clockwise on paper.

## Bed bounds

The bed spans X 0…width and Y 0…height from the work origin (set it with **Set origin** at the top-left corner). A file or drawing that goes outside it shows a warning, and the button becomes **Run anyway**. The API throws a `BoundsError` unless you pass `{ ignoreBounds: true }`. `moveTo`/`lineTo` always check bounds; jogging never does.

## Script

The **Script** tab runs JavaScript with `d` (an empty `Drawing`), `plotter` and `Drawing` in scope. **Build drawing** (Ctrl/⌘+Enter) loads the result into the bar, where **Run** plots it with start and end G-code. If the script returns a `Drawing`, that is used instead of `d`. The script is saved in localStorage.

## Pen

The Z axis never moves. The pen is the servo:

- pen up: `M3 S0` + dwell (`penUpValue`, `penDelay`)
- pen down: `M3 S255` + dwell (`penDownValue`; needs `$30=255`)
- `M5` at the end turns the servo off

When a G-code file is run, Z moves become pen moves: Z ≤ `zThreshold` (default 0) puts the pen down, anything higher lifts it. Z words in other commands (`G28 Z0`, `$J=…Z…`) are removed.

## JavaScript API

`plotter` and `Drawing` are available on `window` (so you can use them from the devtools console):

```js
await plotter.connect()                  // opens the port picker; must come from a click handler
await plotter.plot(new Drawing()
  .rect(10, 10, 80, 50)
  .circle(50, 35, 20)
  .moveTo(10, 10).lineTo(90, 60))        // wrapped in start/end G-code
await plotter.run(gcodeText)             // a G-code file, wrapped in start/end G-code
await plotter.run(text, { start: false, end: false, ignoreBounds: true })

await plotter.penUp(); await plotter.penDown()
await plotter.moveTo(x, y)               // lifts the pen first, then G0
await plotter.lineTo(x, y, feed?)        // lowers the pen first, then G1
await plotter.idle()                     // resolves when motion has physically finished
await plotter.send('G0 X10')             // raw G-code (Z is filtered)
await plotter.jog(dx, dy, feed?)
plotter.pause(); plotter.resume(); await plotter.stop()

plotter.setConfig({ penDownValue: 200, penDelay: 0.3, startGcode: '...', endGcode: '...' })
plotter.on('status', s => …)             // also 'job', 'log', 'connection'
```

Start and end G-code can use `{penUp}` and `{penDown}`. Config is saved in localStorage.

## Layout

- `src/serial.ts`: Web Serial line transport
- `src/grbl.ts`: GRBL protocol (character-counting streaming, real-time commands, status parsing)
- `src/gcode.ts`: Z → pen filter
- `src/drawing.ts`: path builder
- `src/plotter.ts`: the public API
- `src/main.ts`: UI
