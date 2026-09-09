const fs = require('fs');
const html = fs.readFileSync('src/index.html', 'utf8');
const js = ['geom', 'post', 'nest', 'app'].map(n => fs.readFileSync(`src/${n}.js`, 'utf8')).join('\n');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/CNCStudio.html', html.replace('<!--SCRIPTS-->', () => '<script>\n' + js + '\n</script>'));
console.log('built dist/CNCStudio.html', (fs.statSync('dist/CNCStudio.html').size / 1024).toFixed(0) + ' KB');
