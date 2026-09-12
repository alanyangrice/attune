/** Mark dist-electron as CommonJS so Electron smokes work while the repo is "type": "module". */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'dist-electron');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
);
