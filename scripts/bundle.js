const esbuild = require('esbuild');
const path = require('path');

esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'main.js')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['electron'],
  outfile: path.join(__dirname, '..', 'main.bundle.js'),
  minify: true,
}).then(() => {
  console.log('✅ main.bundle.js 생성 완료');
}).catch(e => {
  console.error('Bundle error:', e);
  process.exit(1);
});
