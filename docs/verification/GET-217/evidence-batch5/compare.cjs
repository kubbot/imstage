const fs = require('fs');
const NM = '/Users/cubxxw/ops/symphony/runtime/workspaces/GET-217/node_modules';
const { PNG } = require(NM + '/pngjs');
const pixelmatch = require(NM + '/pixelmatch').default;
const dir = '/Users/cubxxw/linear-work';
const base = JSON.parse(fs.readFileSync(dir + '/ab-base/results.json', 'utf8'));
const cur = JSON.parse(fs.readFileSync(dir + '/ab-cur/results.json', 'utf8'));
for (const name of Object.keys(base)) {
  const b = base[name], c = cur[name];
  if (!b.ok || !c.ok) { console.log(name, '| base:', b.ok ? 'ok' : b.code, '| cur:', c.ok ? 'ok' : c.code); continue; }
  const p1 = PNG.sync.read(fs.readFileSync(dir + '/ab-base/' + name + '.png'));
  const p2 = PNG.sync.read(fs.readFileSync(dir + '/ab-cur/' + name + '.png'));
  if (p1.width !== p2.width || p1.height !== p2.height) { console.log(name, '| DIM DIFF', p1.width + 'x' + p1.height, 'vs', p2.width + 'x' + p2.height); continue; }
  const diff = new PNG({ width: p1.width, height: p1.height });
  const n = pixelmatch(p1.data, p2.data, diff.data, p1.width, p1.height, { threshold: 0.1 });
  console.log(name, '| diffPixels:', n, '| ratio:', (n / (p1.width * p1.height)).toFixed(5), '| identical:', n === 0);
}
