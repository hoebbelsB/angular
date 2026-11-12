// Serves the main and PR @for bench builds and runs __forBench in headless Chrome over CDP.
// usage: node run.mjs <n> <rounds> <reps> [time|mem] > out.json   (builds in ./main and ./pr)
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile, stat, mkdtemp} from 'node:fs/promises';
import {join, extname} from 'node:path';
import {tmpdir} from 'node:os';

const dir = new URL('.', import.meta.url).pathname;
const [n = '1000', rounds = '3', reps = '15', mode = 'time'] = process.argv.slice(2);
// mem: precise heap numbers, gc(), and a young generation large enough that no GC runs inside a tick
const memFlags = [
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc --min-semi-space-size=512 --max-semi-space-size=512',
];
const builds = ['main', 'pr'];
const types = {'.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css'};
const ports = {main: 4311, pr: 4312};

const serve = (root, port) =>
  new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      let p = join(root, new URL(req.url, 'http://x').pathname);
      try {
        if (!(await stat(p)).isFile()) throw 0;
      } catch {
        p = join(root, 'index.html');
      }
      res.writeHead(200, {
        'content-type': types[extname(p)] ?? 'application/octet-stream',
        // cross-origin isolation: finer performance.now() resolution
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      res.end(await readFile(p));
    }).listen(port, () => resolve(server));
  });
const servers = await Promise.all(builds.map((b) => serve(join(dir, b), ports[b])));

const profile = await mkdtemp(join(tmpdir(), 'for-bench-'));
const chrome = spawn(
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--remote-debugging-port=9334',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900',
    ...(mode === 'mem' ? memFlags : []),
    'about:blank',
  ],
  {stdio: 'ignore'},
);

let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find(
      (t) => t.type === 'page',
    )?.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await new Promise((r) => setTimeout(r, 200));
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, {once: true}));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) (pending.get(msg.id)(msg), pending.delete(msg.id));
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({id: i, method, params}));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
const userAgent = await evaluate('navigator.userAgent');
const runs = [];
for (let round = 0; round < Number(rounds); round++) {
  const order = round % 2 ? builds.slice().reverse() : builds;
  for (const build of order) {
    await send('Page.navigate', {url: `http://127.0.0.1:${ports[build]}/`});
    for (let i = 0; i < 100 && !(await evaluate('!!window.__forBench')); i++)
      await new Promise((r) => setTimeout(r, 100));
    const result = await evaluate(
      `__forBench.runAll(${Number(n)}, ${Number(reps)}, ${JSON.stringify(mode)})`,
    );
    runs.push({build, round, ...result});
    process.stderr.write(`n=${n} round ${round} ${build} done\n`);
  }
}
console.log(
  JSON.stringify({n: Number(n), rounds: Number(rounds), reps: Number(reps), mode, userAgent, runs}),
);
ws.close();
chrome.kill();
servers.forEach((s) => s.close());
