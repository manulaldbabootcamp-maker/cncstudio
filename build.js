/* Bundles src/ into the single HTML file the Electron app loads.
   Output goes to electron/app/CNCStudio.html — that is the file main.js
   loads and the only file electron-builder packages (see electron/package.json
   "files": ["main.js", "app/**"]). Do not edit that file by hand: it is
   generated, and editing it is how src/ and the shipped app drifted apart. */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const OUT = path.join(root, 'electron', 'app', 'CNCStudio.html');
const MODULES = ['log', 'geom', 'post', 'nest', 'snap', 'align', 'bool', 'region', 'font', 'trace', 'svg', 'pdf', 'icons', 'app'];

const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
if (!html.includes('<!--SCRIPTS-->')) throw new Error('src/index.html is missing the <!--SCRIPTS--> placeholder');
const js = MODULES.map(n => fs.readFileSync(path.join(root, 'src', `${n}.js`), 'utf8')).join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html.replace('<!--SCRIPTS-->', () => '<script>\n' + js + '\n</script>'));
console.log('built electron/app/CNCStudio.html', (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
