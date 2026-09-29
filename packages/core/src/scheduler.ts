interface Task {
  due: number;
  readonly intervalMs: number | null;
  readonly fn: () => void;
  order: number;
}

/**
 * setTimeout/setInterval driven by an explicit clock, so timer-based behaviour (like the 2019 LED
 * animations) runs identically in the simulator, on the robot and in tests. Call advanceTo() from the
 * main loop with the current time.
 */
export class VirtualScheduler {
  #now: number;
  #nextId = 1;
  #order = 0;
  readonly #tasks = new Map<number, Task>();

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): number {
    return this.#add(fn, Math.max(0, ms), null);
  }

  setInterval(fn: () => void, ms: number): number {
    const period = Math.max(1, ms);
    return this.#add(fn, period, period);
  }

  clear(id: number | null | undefined): void {
    if (id != null) this.#tasks.delete(id);
  }

  /** Runs every callback due up to and including nowMs, in time order (ties in scheduling order). */
  advanceTo(nowMs: number): void {
    for (;;) {
      let nextId = -1;
      let next: Task | undefined;
      for (const [id, task] of this.#tasks) {
        if (task.due > nowMs) continue;
        if (!next || task.due < next.due || (task.due === next.due && task.order < next.order)) {
          next = task;
          nextId = id;
        }
      }
      if (!next) break;
      this.#now = next.due;
      if (next.intervalMs === null) {
        this.#tasks.delete(nextId);
      } else {
        next.due += next.intervalMs;
        next.order = this.#order++;
      }
      next.fn();
    }
    this.#now = Math.max(this.#now, nowMs);
  }

  #add(fn: () => void, delayMs: number, intervalMs: number | null): number {
    const id = this.#nextId++;
    this.#tasks.set(id, { due: this.#now + delayMs, intervalMs, fn, order: this.#order++ });
    return id;
  }
}
