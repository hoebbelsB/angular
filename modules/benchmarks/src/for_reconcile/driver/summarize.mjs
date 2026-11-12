// node summarize.mjs out.json [tick|frame|alloc|retained] -> markdown table of pooled medians + p25-p75
import {readFileSync} from 'node:fs';
const [file, key = 'tick'] = process.argv.slice(2);
const d = JSON.parse(readFileSync(file, 'utf8'));
const q = (xs, p) => {
  const s = xs.slice().sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
const pick = (build, s) =>
  d.runs.filter((r) => r.build === build).map((r) => r.results.find((x) => x.scenario === s));
const pool = (build, s) => pick(build, s).flatMap((r) => r[key]);
const isMem = key === 'alloc' || key === 'retained';
const unit = isMem ? 'KB' : 'ms';
const num = (x) =>
  Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);
const fmt = (x) => num(isMem ? x / 1024 : x);
const scenarios = d.runs[0].results.map((r) => r.scenario);
const samples = pool('main', scenarios[0]).length;
console.log(
  `n=${d.n}, metric=${key}, ${d.rounds} rounds x ${d.reps} reps = ${samples} samples/build, ${d.userAgent.match(/Chrome\/[\d.]+/)?.[0]} headless, crossOriginIsolated=${d.runs[0].crossOriginIsolated}\n`,
);
console.log(
  `| scenario | main ${unit} | PR ${unit} | Δ | main p25–p75 | PR p25–p75 |${isMem ? '' : ' DOM add+remove main → PR |'}`,
);
console.log(`| --- | ---: | ---: | ---: | ---: | ---: |${isMem ? '' : ' ---: |'}`);
for (const s of scenarios) {
  const m = pool('main', s),
    p = pool('pr', s);
  const [mm, pm] = [q(m, 0.5), q(p, 0.5)];
  const dm = pick('main', s)[0],
    dp = pick('pr', s)[0];
  console.log(
    `| ${s} | ${fmt(mm)} | ${fmt(pm)} | ${Math.abs(mm) < 1e-9 ? '–' : `${((pm / mm - 1) * 100).toFixed(0)}%`} | ${fmt(q(m, 0.25))}–${fmt(q(m, 0.75))} | ${fmt(q(p, 0.25))}–${fmt(q(p, 0.75))} |${isMem ? '' : ` ${dm.domAdded}+${dm.domRemoved} → ${dp.domAdded}+${dp.domRemoved} |`}`,
  );
}
