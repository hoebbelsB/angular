// time: node bench.mjs <n> <samples>
// mem:  node --expose-gc --min-semi-space-size=256 --max-semi-space-size=256 bench.mjs <n> <samples>
import {PerformanceObserver, constants} from 'node:perf_hooks';
import * as mainR from './main/list_reconciliation';
import * as prR from './pr/list_reconciliation';

type Item = {id: number; label: string};
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
  updateEvery10th: {next: (a) => a.map((x, i) => (i % 10 === 0 ? {...x} : x))},
  updateAll: {next: (a) => a.map((x) => ({...x}))},
  filterHalf: {next: (a) => a.filter((x) => x.id % 2 === 0)},
  replaceAll: {next: (a) => range(a.length, 1e6)},
};
let trackCalls = 0;
const trackBy = (_: number, i: Item) => (trackCalls++, i.id);

function lc(R: any, values: Item[]) {
  // models LiveCollectionLContainerImpl: array splices for attach/detach (like removeFromArray /
  // addToArray), at() reads the context. Detached state is a flag, so the harness itself does not
  // allocate per move beyond what splice does in Angular too.
  return new (class extends R.LiveCollection<any, Item> {
    e = values.map((value) => ({value, d: false}));
    nd = 0;
    c = {
      at: 0,
      attach: 0,
      detach: 0,
      moves: 0,
      create: 0,
      destroy: 0,
      update: 0,
      peak: values.length,
    };
    get length() {
      return this.e.length;
    }
    at(i: number) {
      this.c.at++;
      return this.e[i].value;
    }
    attach(i: number, x: any) {
      this.c.attach++;
      if (x.d) (this.c.moves++, (x.d = false), this.nd--);
      this.e.splice(i, 0, x);
      this.c.peak = Math.max(this.c.peak, this.e.length + this.nd);
    }
    detach(i: number) {
      this.c.detach++;
      const x = this.e.splice(i, 1)[0];
      x.d = true;
      this.nd++;
      return x;
    }
    create(_: number, value: Item) {
      this.c.create++;
      return {value, d: false};
    }
    destroy(x: any) {
      if (x.d) (this.nd--, (x.d = false));
      this.c.destroy++;
    }
    updateValue(i: number, v: Item) {
      this.c.update++;
      this.e[i].value = v;
    }
  })();
}
const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function time(R: any, base: Item[], next: Item[], samples: number) {
  for (let i = 0; i < 20; i++) R.reconcile(lc(R, base), next, trackBy, null);
  const xs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const l = lc(R, base);
    const t0 = performance.now();
    R.reconcile(l, next, trackBy, null);
    xs.push((performance.now() - t0) * 1000);
  }
  return median(xs);
}
// Memory mode (node --expose-gc ...): bytes allocated by one reconcile() call, incl. garbage, the
// splice arrays and the created view stubs. Relies on a young generation large enough that no GC runs
// inside the call; a minor GC observed during the measurement aborts the run. Timing runs without
// these flags so GC behaves as by default.
const gc = (globalThis as any).gc as (() => void) | undefined;
const MEM = !!gc;
let minorGCs = 0;
if (MEM) {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries())
      if ((e as any).detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR) minorGCs++;
  }).observe({entryTypes: ['gc']});
}
const used = () => process.memoryUsage().heapUsed;
const flushGC = () => new Promise((r) => setTimeout(r, 0));
async function bytes(R: any, base: Item[], next: Item[], samples: number) {
  const xs: number[] = [];
  const empty: number[] = [];
  for (let i = -5; i < samples; i++) {
    const l = lc(R, base);
    gc!();
    const h0 = used();
    const h1 = used();
    R.reconcile(l, next, trackBy, null);
    const h2 = used();
    if (i >= 0) (empty.push(h1 - h0), xs.push(h2 - h1));
  }
  await flushGC();
  if (minorGCs) throw new Error('minor GC during allocation measurement, raise semi-space size');
  return median(xs) - median(empty);
}
const N = Number(process.argv[2] ?? 1000),
  SAMPLES = Number(process.argv[3] ?? 101);
const last = MEM ? 'allocated KB main → PR' : 'reconcile µs main → PR';
console.log(
  `n=${N}, ${SAMPLES} samples, median, node ${process.version}, ngDevMode=false${MEM ? ', KB = bytes allocated per reconcile() call' : ''}\n`,
);
console.log(
  `| scenario | moves main → PR | trackBy calls main → PR | at() main → PR | updateValue main → PR | peak views main → PR | ${last} |`,
);
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [name, sc] of Object.entries(SCENARIOS)) {
  const rnd = seeded(1);
  const base = sc.base ? sc.base(range(N), rnd) : range(N);
  const next = sc.next(base, rnd);
  const r: any = {};
  for (const [k, R] of [
    ['main', mainR],
    ['pr', prR],
  ] as const) {
    trackCalls = 0;
    const l = lc(R, base);
    R.reconcile(l, next, trackBy, null);
    if (l.e.length !== next.length || !l.e.every((x: any, i: number) => x.value === next[i]))
      throw new Error(`${k} ${name} wrong result`);
    const c = {...l.c, track: trackCalls};
    r[k] = {
      ...c,
      v: MEM ? (await bytes(R, base, next, SAMPLES)) / 1024 : time(R, base, next, SAMPLES),
    };
  }
  const f = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
  console.log(
    `| ${name} | ${r.main.moves} → ${r.pr.moves} | ${r.main.track} → ${r.pr.track} | ${r.main.at} → ${r.pr.at} | ${r.main.update} → ${r.pr.update} | ${r.main.peak} → ${r.pr.peak} | ${f(r.main.v)} → ${f(r.pr.v)} |`,
  );
}
