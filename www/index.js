import { Universe, wasmMemory } from "wasm-game-of-life";

// ---- Grid sizing ---------------------------------------------------------

// Cell size in CSS pixels. A finger is roughly 44px wide, so cells this size
// are drawable with a bit of care while still fitting a useful universe on a
// phone screen.
const CELL_SIZE = 11;
// Keep grid lines off once cells get small enough that the lines would eat
// most of the cell.
const GRID_LINE_MIN_CELL_SIZE = 7;
// An iPhone can tick a grid this big well inside a frame; the cap stops a
// large iPad in landscape from quietly dropping to single-digit frame rates.
const MAX_CELLS = 24000;

const canvas = document.getElementById("game-of-life-canvas");
const stage = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: false });

const generationLabel = document.getElementById("generation");
const populationLabel = document.getElementById("population");
const playButton = document.getElementById("play");
const speedInput = document.getElementById("speed");
const speedValue = document.getElementById("speed-value");
const densityInput = document.getElementById("density");
const densityValue = document.getElementById("density-value");

let colours = readColours();
let cellSize = CELL_SIZE;
let cols = 0;
let rows = 0;
let originX = 0;
let originY = 0;

let universe = null;
let playing = false;
let fps = Number(speedInput.value);
let density = Number(densityInput.value) / 100;
let lastTick = 0;
let frame = null;
let wakeLock = null;

// Colours live in the stylesheet so the grid follows the system light/dark
// setting along with the rest of the chrome.
function readColours() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) =>
    (styles.getPropertyValue(name) || fallback).trim();

  return {
    dead: read("--cell-dead", "#170B27"),
    alive: read("--cell-alive", "#A76BFF"),
    line: read("--grid-line", "#2A1547"),
  };
}

// Fits the grid to the stage, matching the canvas backing store to the
// device's pixel density so cells and grid lines land on whole pixels instead
// of blurring across them on a Retina screen.
function layout() {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width === 0 || height === 0) {
    return false;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cellSize = CELL_SIZE;
  let nextCols = Math.max(1, Math.floor(width / cellSize));
  let nextRows = Math.max(1, Math.floor(height / cellSize));

  // On a big screen, grow the cells rather than the cell count.
  while (nextCols * nextRows > MAX_CELLS) {
    cellSize += 1;
    nextCols = Math.max(1, Math.floor(width / cellSize));
    nextRows = Math.max(1, Math.floor(height / cellSize));
  }

  // Centre the grid so the leftover pixels are split evenly rather than
  // leaving a single fat gutter down one side.
  originX = Math.floor((width - nextCols * cellSize) / 2);
  originY = Math.floor((height - nextRows * cellSize) / 2);

  const changed = nextCols !== cols || nextRows !== rows;
  cols = nextCols;
  rows = nextRows;
  return changed;
}

// ---- Reading the grid out of wasm ---------------------------------------

// The bitset lives in wasm linear memory. That buffer is detached whenever the
// heap grows, so the view is rebuilt on every read instead of being cached.
function cellsView() {
  const bytes = Math.ceil((cols * rows) / 8);
  return new Uint8Array(wasmMemory().buffer, universe.cells(), bytes);
}

function bitIsSet(n, arr) {
  return (arr[n >> 3] & (1 << (n & 7))) !== 0;
}

// ---- Drawing -------------------------------------------------------------

function draw() {
  const width = cols * cellSize;
  const height = rows * cellSize;

  // One fill for every dead cell, then a rect per live cell. Painting only
  // the live minority keeps the frame cheap on a phone GPU.
  ctx.fillStyle = colours.dead;
  ctx.fillRect(0, 0, stage.clientWidth, stage.clientHeight);

  const drawLines = cellSize >= GRID_LINE_MIN_CELL_SIZE;
  // Leave a pixel for the grid line, but only when there is a line to leave it
  // for — at small cell sizes the gap alone would fray the pattern.
  const fillSize = drawLines ? cellSize - 1 : cellSize;

  const cells = cellsView();
  ctx.fillStyle = colours.alive;
  for (let row = 0; row < rows; row++) {
    const rowOffset = row * cols;
    const y = originY + row * cellSize;
    for (let col = 0; col < cols; col++) {
      if (bitIsSet(rowOffset + col, cells)) {
        ctx.fillRect(originX + col * cellSize, y, fillSize, fillSize);
      }
    }
  }

  if (drawLines) {
    ctx.beginPath();
    ctx.strokeStyle = colours.line;
    ctx.lineWidth = 1;
    for (let col = 0; col <= cols; col++) {
      const x = originX + col * cellSize - 0.5;
      ctx.moveTo(x, originY);
      ctx.lineTo(x, originY + height);
    }
    for (let row = 0; row <= rows; row++) {
      const y = originY + row * cellSize - 0.5;
      ctx.moveTo(originX, y);
      ctx.lineTo(originX + width, y);
    }
    ctx.stroke();
  }
}

function updateHud() {
  generationLabel.textContent = `Gen ${universe.generation()}`;
  populationLabel.textContent = `${universe.population()} alive`;
}

function render() {
  draw();
  updateHud();
}

// ---- Simulation loop -----------------------------------------------------

// A timestamp-driven loop rather than `setTimeout`: the speed slider then
// means the same thing regardless of the display's refresh rate, and the
// browser throttles the whole thing when the app is backgrounded.
function loop(now) {
  if (!playing) {
    frame = null;
    return;
  }

  if (now - lastTick >= 1000 / fps) {
    lastTick = now;
    universe.tick();
    render();
  }

  frame = requestAnimationFrame(loop);
}

function start() {
  if (playing) {
    return;
  }
  playing = true;
  lastTick = 0;
  playButton.firstChild.nodeValue = "⏸";
  playButton.querySelector(".label").textContent = "Pause";
  requestWakeLock();
  frame = requestAnimationFrame(loop);
}

function stop() {
  playing = false;
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  playButton.firstChild.nodeValue = "▶︎";
  playButton.querySelector(".label").textContent = "Play";
  releaseWakeLock();
}

// Nobody expects the screen to dim while they are watching a simulation run,
// and nobody wants it held awake once it is paused.
async function requestWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock !== null) {
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (e) {
    // Denied in the background, or unsupported. Not worth surfacing.
    wakeLock = null;
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ---- Touch drawing -------------------------------------------------------

// While a drag is in progress every cell it crosses is forced to the state the
// first touch produced. Toggling per cell instead would flip cells back off as
// a finger wobbles over them.
let paintValue = null;
let lastPainted = null;

function cellAt(event) {
  const rect = canvas.getBoundingClientRect();
  const col = Math.floor((event.clientX - rect.left - originX) / cellSize);
  const row = Math.floor((event.clientY - rect.top - originY) / cellSize);
  if (row < 0 || col < 0 || row >= rows || col >= cols) {
    return null;
  }
  return { row, col };
}

canvas.addEventListener("pointerdown", (event) => {
  const cell = cellAt(event);
  if (cell === null) {
    return;
  }

  // Capture keeps the drag alive if the finger slides off the canvas and over
  // the control bar.
  canvas.setPointerCapture(event.pointerId);

  const wasAlive = bitIsSet(cell.row * cols + cell.col, cellsView());
  paintValue = !wasAlive;
  lastPainted = `${cell.row}:${cell.col}`;
  universe.set_cell(cell.row, cell.col, paintValue);
  render();
});

canvas.addEventListener("pointermove", (event) => {
  if (paintValue === null) {
    return;
  }

  const cell = cellAt(event);
  if (cell === null) {
    return;
  }

  const key = `${cell.row}:${cell.col}`;
  if (key === lastPainted) {
    return;
  }
  lastPainted = key;
  universe.set_cell(cell.row, cell.col, paintValue);
  render();
});

function endPaint() {
  paintValue = null;
  lastPainted = null;
}

canvas.addEventListener("pointerup", endPaint);
canvas.addEventListener("pointercancel", endPaint);

// Belt and braces alongside `touch-action: none` — older iOS Safari still
// fires these gesture events for a pinch inside the page.
for (const name of ["gesturestart", "gesturechange", "gestureend"]) {
  document.addEventListener(name, (event) => event.preventDefault());
}

// Double-tap-to-zoom is turned off in CSS via `touch-action`, not by
// swallowing `touchend` here: cancelling that event also cancels the click
// Safari synthesises from it, which would drop every second tap when someone
// taps Step or Glider in quick succession.

// ---- Controls ------------------------------------------------------------

playButton.addEventListener("click", () => {
  if (playing) {
    stop();
  } else {
    start();
  }
});

document.getElementById("step").addEventListener("click", () => {
  stop();
  universe.tick();
  render();
});

document.getElementById("random").addEventListener("click", () => {
  universe.randomize(density);
  render();
});

document.getElementById("clear").addEventListener("click", () => {
  stop();
  universe.clear();
  render();
});

document.getElementById("glider").addEventListener("click", () => {
  // Drop it near the top-left so it has the whole grid to travel across.
  universe.insert_glider(Math.floor(rows / 4), Math.floor(cols / 4));
  render();
});

speedInput.addEventListener("input", () => {
  fps = Number(speedInput.value);
  speedValue.textContent = `${fps} fps`;
});

densityInput.addEventListener("input", () => {
  density = Number(densityInput.value) / 100;
  densityValue.textContent = `${densityInput.value}%`;
});

// ---- Lifecycle -----------------------------------------------------------

// Rotating the device or Safari collapsing its address bar changes how many
// cells fit. The pattern is carried across the resize so the grid is not wiped
// out by turning the phone sideways.
function resizeUniverse() {
  const previous = {
    cols,
    rows,
    cells: Uint8Array.from(cellsView()),
  };

  if (!layout()) {
    render();
    return;
  }

  universe.resize(cols, rows);

  const copyRows = Math.min(previous.rows, rows);
  const copyCols = Math.min(previous.cols, cols);
  for (let row = 0; row < copyRows; row++) {
    for (let col = 0; col < copyCols; col++) {
      if (bitIsSet(row * previous.cols + col, previous.cells)) {
        universe.set_cell(row, col, true);
      }
    }
  }

  render();
}

let resizeTimer = null;
function onResize() {
  // iOS fires a burst of these mid-rotation. Settle first, then rebuild once.
  if (resizeTimer !== null) {
    clearTimeout(resizeTimer);
  }
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    resizeUniverse();
  }, 150);
}

window.addEventListener("resize", onResize);
window.addEventListener("orientationchange", onResize);

// Pause when the app is backgrounded: a suspended tab cannot animate, and on a
// phone the alternative is burning battery on frames nobody sees. iOS also
// drops the wake lock on the way out, so it has to be retaken on the way back.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stop();
  } else if (playing) {
    requestWakeLock();
  }
});

const colourScheme = window.matchMedia("(prefers-color-scheme: dark)");
const onSchemeChange = () => {
  colours = readColours();
  render();
};
if (typeof colourScheme.addEventListener === "function") {
  colourScheme.addEventListener("change", onSchemeChange);
} else {
  // Safari before 14.
  colourScheme.addListener(onSchemeChange);
}

// ---- Boot ----------------------------------------------------------------

layout();
universe = Universe.empty(cols, rows);
universe.randomize(density);
speedValue.textContent = `${fps} fps`;
densityValue.textContent = `${densityInput.value}%`;
render();
start();

// Registered so the app keeps working with no network — the expectation for
// anything launched from the home screen. Guarded because the API is absent
// over `file://` and inside some native web views.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Offline support is a bonus; the app runs fine without it.
    });
  });
}
