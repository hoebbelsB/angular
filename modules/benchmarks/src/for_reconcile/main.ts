/**
 * @for reconciliation benchmark: A/B the list reconciler on scenario updates.
 * Exposes `window.__forBench.runAll(n, reps, 'time' | 'mem')` for a CDP driver. Every rep is validated against the DOM.
 */
import {
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  enableProdMode,
  signal,
} from '@angular/core';
import {bootstrapApplication} from '@angular/platform-browser';

interface Item {
  id: number;
  label: string;
}

@Component({
  selector: 'for-bench',
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <table>
      <tbody>
        @for (item of data(); track item.id) {
          <tr [attr.data-id]="item.id">
            <td>{{ item.id }}</td>
            <td>
              <a href="#">{{ item.label }}</a>
            </td>
            <td><span class="remove"></span></td>
            <td></td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
class ForBenchComponent {
  data = signal<Item[]>([]);
}

const item = (id: number): Item => ({id, label: `item ${id}`});
const range = (n: number, off = 0) => Array.from({length: n}, (_, i) => item(i + off));
const seeded = (seed: number) => (n: number) =>
  Math.floor(((seed = (seed * 16807) % 2147483647) / 2147483647) * n);
const shuffle = <T>(a: T[], rnd: (n: number) => number) => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const relocate = <T>(a: T[], c: number, rnd: (n: number) => number) => {
  a = a.slice();
  for (let k = 0; k < c; k++) a.splice(rnd(a.length), 0, ...a.splice(rnd(a.length), 1));
  return a;
};

type Scenario = {
  base?: (a: Item[], r: (n: number) => number) => Item[];
  next: (a: Item[], r: (n: number) => number) => Item[];
};
const SCENARIOS: Record<string, Scenario> = {
  append: {next: (a) => [...a, item(1e6)]},
  prepend: {next: (a) => [item(1e6), ...a]},
  insertMiddle: {
    next: (a) => {
      const m = a.length >> 1;
      return [...a.slice(0, m), item(1e6), ...a.slice(m)];
    },
  },
  removeFirst: {next: (a) => a.slice(1)},
  removeMiddle: {next: (a) => a.filter((_, i) => i !== a.length >> 1)},
  slidingWindow: {next: (a) => [...a.slice(1), item(1e6)]},
  swap: {
    next: (a) => {
      const b = a.slice();
      const j = b.length - 10;
      [b[10], b[j]] = [b[j], b[10]];
      return b;
    },
  },
  moveOne: {
    next: (a) => {
      const b = a.slice();
      b.splice(b.length - 10, 0, ...b.splice(10, 1));
      return b;
    },
  },
  relocate10: {next: (a, r) => relocate(a, 10, r)},
  sortNearlySorted: {
    base: (a, r) => relocate(a, Math.ceil(a.length / 20), r),
    next: (a) => a.slice().sort((x, y) => x.id - y.id),
  },
  shuffle: {next: (a, r) => shuffle(a, r)},
  reverse: {next: (a) => a.slice().reverse()},
  updateEvery10th: {
    next: (a) => a.map((x, i) => (i % 10 === 0 ? {...x, label: x.label + '!'} : x)),
  },
  updateAll: {next: (a) => a.map((x) => ({...x, label: x.label + '!'}))},
  filterHalf: {next: (a) => a.filter((x) => x.id % 2 === 0)},
  replaceAll: {next: (a) => range(a.length, 1e6)},
};

// resolves after the next frame was produced (style, layout, paint of the change)
const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    }),
  );

enableProdMode();
bootstrapApplication(ForBenchComponent).then((appRef: ApplicationRef) => {
  const component = appRef.components[0].instance as ForBenchComponent;
  const tbody = document.querySelector('tbody')!;

  const render = (data: Item[]) => {
    component.data.set(data);
    appRef.tick();
  };
  const check = (expected: Item[], name: string) => {
    const rows = tbody.children;
    if (rows.length !== expected.length) {
      throw new Error(`${name}: ${rows.length} rows, expected ${expected.length}`);
    }
    for (let i = 0; i < expected.length; i++) {
      const row = rows[i] as HTMLElement;
      if (
        row.getAttribute('data-id') !== String(expected[i].id) ||
        row.children[1].textContent !== expected[i].label
      ) {
        throw new Error(
          `${name}: row ${i} shows ${row.getAttribute('data-id')}, expected ${expected[i].id}`,
        );
      }
    }
  };
  const data = (name: string, n: number) => {
    const sc = SCENARIOS[name];
    const rnd = seeded(1);
    const base = sc.base ? sc.base(range(n), rnd) : range(n);
    return {base, next: sc.next(base, rnd)};
  };

  async function run(name: string, n: number, reps: number) {
    const {base, next} = data(name, n);
    // DOM operation counts (deterministic, separate untimed pass)
    render([]);
    render(base);
    let added = 0;
    let removed = 0;
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.target === tbody) {
          added += r.addedNodes.length;
          removed += r.removedNodes.length;
        }
      }
    });
    mo.observe(tbody, {childList: true});
    render(next);
    await Promise.resolve();
    for (const r of mo.takeRecords()) {
      if (r.target === tbody) {
        added += r.addedNodes.length;
        removed += r.removedNodes.length;
      }
    }
    mo.disconnect();
    check(next, name);

    const tick: number[] = [];
    const frame: number[] = [];
    for (let rep = -2; rep < reps; rep++) {
      render([]);
      render(base);
      check(base, name);
      await nextFrame();
      await nextFrame();
      const t0 = performance.now();
      render(next);
      const t1 = performance.now();
      await nextFrame();
      const t2 = performance.now();
      check(next, name);
      if (rep >= 0) {
        tick.push(t1 - t0);
        frame.push(t2 - t0);
      }
    }
    render([]);
    return {scenario: name, n, domAdded: added, domRemoved: removed, tick, frame};
  }

  // V8 heap per update. Needs Chrome with --enable-precise-memory-info and
  // --js-flags="--expose-gc --min-semi-space-size=.. --max-semi-space-size=.." so no GC runs inside the
  // tick: then usedJSHeapSize after - before = bytes allocated by the update (incl. garbage).
  // retained = heap after GC with `next` rendered - heap after GC with `base` rendered. GC runs twice:
  // after a single gc() up to ~50 KB of garbage from the previous update can survive until the next one.
  // Blink/Oilpan (DOM node) memory is not in usedJSHeapSize.
  async function mem(name: string, n: number, reps: number) {
    const gc = () => ((window as any).gc(), (window as any).gc());
    const heap = () => (performance as any).memory.usedJSHeapSize as number;
    const {base, next} = data(name, n);
    const alloc: number[] = [];
    const retained: number[] = [];
    // heap after GC with `base` rendered, per rep: grows if updates leak
    const baseline: number[] = [];
    for (let rep = -2; rep < reps; rep++) {
      render([]);
      render(base);
      check(base, name);
      await nextFrame();
      gc();
      const h0 = heap();
      render(next);
      const h1 = heap();
      check(next, name);
      await nextFrame();
      gc();
      const h2 = heap();
      if (rep >= 0) {
        alloc.push(h1 - h0);
        retained.push(h2 - h0);
        baseline.push(h0);
      }
    }
    render([]);
    return {scenario: name, n, alloc, retained, baseline};
  }

  (window as any).__forBench = {
    scenarios: Object.keys(SCENARIOS),
    run,
    async runAll(n: number, reps: number, mode: 'time' | 'mem' = 'time') {
      const results = [];
      for (const name of Object.keys(SCENARIOS)) {
        results.push(await (mode === 'mem' ? mem : run)(name, n, reps));
      }
      return {crossOriginIsolated: (window as any).crossOriginIsolated, results};
    },
  };
});
