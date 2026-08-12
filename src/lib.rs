use fixedbitset::FixedBitSet;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cell {
    Dead = 0,
    Alive = 1,
}

/// Installs the panic hook so a Rust panic shows up as a `console.error`
/// instead of an unhelpful `unreachable executed` trap. On iOS the only way
/// to see a wasm trap is Safari's remote inspector, so the readable message
/// matters more here than it does on desktop.
#[wasm_bindgen(start)]
pub fn start() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// The wasm linear memory, so JavaScript can read the cell bitset in place
/// rather than copying the whole grid across the boundary every frame.
/// Reaching for it through `wasm_bindgen::memory()` keeps the front end from
/// having to import `memory` out of a generated file whose name and exports
/// shift between wasm-pack releases.
#[wasm_bindgen(js_name = wasmMemory)]
pub fn wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}

#[wasm_bindgen]
pub struct Universe {
    width: u32,
    height: u32,
    cells: FixedBitSet,
    // Scratch buffer reused by `tick`. Allocating a fresh grid every frame is
    // affordable on desktop but shows up as GC jitter at 60fps on a phone.
    next: FixedBitSet,
    generation: u32,
}

impl Universe {
    fn get_index(&self, row: u32, col: u32) -> usize {
        (row * self.width + col) as usize
    }

    fn live_neighbour_count(&self, row: u32, col: u32) -> u8 {
        let mut count = 0;
        for delta_row in [self.height - 1, 0, 1].iter().cloned() {
            for delta_col in [self.width - 1, 0, 1].iter().cloned() {
                if delta_row == 0 && delta_col == 0 {
                    continue;
                }

                let neighbour_row = (row + delta_row) % self.height;
                let neighbour_col = (col + delta_col) % self.width;
                let idx = self.get_index(neighbour_row, neighbour_col);
                count += self.cells[idx] as u8;
            }
        }
        count
    }

    /// Builds an all-dead universe. Kept out of the `wasm_bindgen` block so it
    /// is usable from native unit tests, where `js_sys::Math::random` traps.
    fn blank(width: u32, height: u32) -> Universe {
        let size = (width * height) as usize;
        Universe {
            width,
            height,
            cells: FixedBitSet::with_capacity(size),
            next: FixedBitSet::with_capacity(size),
            generation: 0,
        }
    }

    /// Cells as a bit slice, for assertions in tests.
    #[cfg(test)]
    fn is_alive(&self, row: u32, col: u32) -> bool {
        let idx = self.get_index(row, col);
        self.cells[idx]
    }
}

#[wasm_bindgen]
impl Universe {
    /// A universe seeded with random cells, each alive with probability `p`.
    pub fn new(width: u32, height: u32, p: f64) -> Universe {
        let mut universe = Universe::blank(width, height);
        universe.randomize(p);
        universe
    }

    /// A universe with every cell dead — the starting point for drawing a
    /// pattern by hand, which is the primary way you interact on a touch
    /// screen.
    pub fn empty(width: u32, height: u32) -> Universe {
        Universe::blank(width, height)
    }

    /// Advances the simulation by one generation.
    pub fn tick(&mut self) {
        for row in 0..self.height {
            for col in 0..self.width {
                let idx = self.get_index(row, col);
                let cell = self.cells[idx];
                let live_neighbours = self.live_neighbour_count(row, col);

                self.next.set(
                    idx,
                    match (cell, live_neighbours) {
                        (true, x) if x < 2 => false,
                        (true, 2) | (true, 3) => true,
                        (true, x) if x > 3 => false,
                        (false, 3) => true,
                        (other, _) => other,
                    },
                );
            }
        }

        std::mem::swap(&mut self.cells, &mut self.next);
        self.generation = self.generation.wrapping_add(1);
    }

    /// Reseeds every cell, each alive with probability `p`.
    pub fn randomize(&mut self, p: f64) {
        let size = (self.width * self.height) as usize;
        for i in 0..size {
            self.cells.set(i, js_sys::Math::random() < p);
        }
        self.generation = 0;
    }

    /// Kills every cell.
    pub fn clear(&mut self) {
        self.cells.clear();
        self.generation = 0;
    }

    /// Resizes the grid, discarding its contents. Called when the device
    /// rotates or the viewport changes, so the grid always matches the number
    /// of cells that actually fit on screen.
    pub fn resize(&mut self, width: u32, height: u32) {
        let size = (width * height) as usize;
        self.width = width;
        self.height = height;
        self.cells = FixedBitSet::with_capacity(size);
        self.next = FixedBitSet::with_capacity(size);
        self.generation = 0;
    }

    /// Flips one cell — what a tap does. Out-of-range coordinates are ignored
    /// rather than panicking: a touch can land on the edge of the canvas and
    /// round to a cell just past the last row or column.
    pub fn toggle_cell(&mut self, row: u32, col: u32) {
        if row >= self.height || col >= self.width {
            return;
        }
        let idx = self.get_index(row, col);
        let alive = self.cells[idx];
        self.cells.set(idx, !alive);
    }

    /// Sets one cell to a known state — what a drag does, so that sliding a
    /// finger paints a continuous line instead of flickering cells on and off.
    pub fn set_cell(&mut self, row: u32, col: u32, alive: bool) {
        if row >= self.height || col >= self.width {
            return;
        }
        let idx = self.get_index(row, col);
        self.cells.set(idx, alive);
    }

    /// Stamps a glider with its top-left corner at (`row`, `col`), wrapping at
    /// the edges. Drawing one cell at a time on a phone is fiddly, so the app
    /// offers this as a one-tap way to get something moving.
    pub fn insert_glider(&mut self, row: u32, col: u32) {
        const GLIDER: [(u32, u32); 5] = [(0, 1), (1, 2), (2, 0), (2, 1), (2, 2)];
        for (d_row, d_col) in GLIDER.iter().cloned() {
            let r = (row + d_row) % self.height;
            let c = (col + d_col) % self.width;
            let idx = self.get_index(r, c);
            self.cells.set(idx, true);
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Generations elapsed since the last reset, for the on-screen counter.
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// Number of live cells, for the on-screen counter.
    pub fn population(&self) -> u32 {
        self.cells.count_ones(..) as u32
    }

    pub fn cells(&self) -> *const u32 {
        self.cells.as_slice().as_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blinker_oscillates_with_period_two() {
        let mut universe = Universe::empty(5, 5);
        universe.set_cell(2, 1, true);
        universe.set_cell(2, 2, true);
        universe.set_cell(2, 3, true);

        universe.tick();

        // The horizontal bar becomes a vertical one.
        assert!(universe.is_alive(1, 2));
        assert!(universe.is_alive(2, 2));
        assert!(universe.is_alive(3, 2));
        assert!(!universe.is_alive(2, 1));
        assert!(!universe.is_alive(2, 3));

        universe.tick();

        // ...and back again.
        assert!(universe.is_alive(2, 1));
        assert!(universe.is_alive(2, 2));
        assert!(universe.is_alive(2, 3));
        assert_eq!(universe.population(), 3);
    }

    #[test]
    fn block_is_still_life() {
        let mut universe = Universe::empty(6, 6);
        for (row, col) in [(1, 1), (1, 2), (2, 1), (2, 2)].iter().cloned() {
            universe.set_cell(row, col, true);
        }

        universe.tick();

        assert_eq!(universe.population(), 4);
        for (row, col) in [(1, 1), (1, 2), (2, 1), (2, 2)].iter().cloned() {
            assert!(universe.is_alive(row, col));
        }
    }

    #[test]
    fn glider_walks_diagonally() {
        let mut universe = Universe::empty(16, 16);
        universe.insert_glider(4, 4);
        assert_eq!(universe.population(), 5);

        // A glider returns to its original shape one cell down and right
        // every four generations.
        for _ in 0..4 {
            universe.tick();
        }

        assert_eq!(universe.population(), 5);
        for (d_row, d_col) in [(0, 1), (1, 2), (2, 0), (2, 1), (2, 2)].iter().cloned() {
            assert!(universe.is_alive(5 + d_row, 5 + d_col));
        }
    }

    #[test]
    fn toggle_flips_a_single_cell() {
        let mut universe = Universe::empty(4, 4);

        universe.toggle_cell(1, 2);
        assert!(universe.is_alive(1, 2));
        assert_eq!(universe.population(), 1);

        universe.toggle_cell(1, 2);
        assert!(!universe.is_alive(1, 2));
        assert_eq!(universe.population(), 0);
    }

    #[test]
    fn out_of_range_touches_are_ignored() {
        let mut universe = Universe::empty(4, 4);

        // A touch on the very edge of the canvas can round past the last cell.
        universe.toggle_cell(4, 0);
        universe.toggle_cell(0, 4);
        universe.set_cell(99, 99, true);

        assert_eq!(universe.population(), 0);
    }

    #[test]
    fn tick_counts_generations_and_clear_resets_them() {
        let mut universe = Universe::empty(8, 8);
        universe.insert_glider(0, 0);

        universe.tick();
        universe.tick();
        assert_eq!(universe.generation(), 2);

        universe.clear();
        assert_eq!(universe.generation(), 0);
        assert_eq!(universe.population(), 0);
    }

    #[test]
    fn resize_changes_the_grid_and_empties_it() {
        let mut universe = Universe::empty(8, 8);
        universe.set_cell(3, 3, true);

        universe.resize(20, 10);

        assert_eq!(universe.width(), 20);
        assert_eq!(universe.height(), 10);
        assert_eq!(universe.population(), 0);

        // The new bounds are honoured in both directions.
        universe.set_cell(9, 19, true);
        assert!(universe.is_alive(9, 19));
        assert_eq!(universe.population(), 1);
    }

    #[test]
    fn edges_wrap_around() {
        // A blinker straddling the top and bottom edge only oscillates if
        // neighbour lookups wrap.
        let mut universe = Universe::empty(5, 5);
        universe.set_cell(4, 2, true);
        universe.set_cell(0, 2, true);
        universe.set_cell(1, 2, true);

        universe.tick();

        assert!(universe.is_alive(0, 1));
        assert!(universe.is_alive(0, 2));
        assert!(universe.is_alive(0, 3));
        assert_eq!(universe.population(), 3);
    }
}
