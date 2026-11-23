const { app, BrowserWindow, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

/* ONE settings store, whichever way the app is started.

   Settings (bed size, tools, materials, the lot) live in localStorage, and
   localStorage lives in Electron's userData folder - which is named after the
   app. `electron .` took the package name, "cnc-studio"; the packaged exe
   takes the product name, "CNC Studio". So the two had SEPARATE settings, and
   a bed size customised in one came up as the 60 x 120 default in the other.
   Nothing was lost and no cache was stale - they were two different stores.

   Pin the name so there is only ever one, and carry the old folder over the
   first time, so a machine that has been using `npm start` keeps everything. */
app.setName('CNC Studio');
try {
  const here = app.getPath('userData');
  const legacy = path.join(path.dirname(here), 'cnc-studio');
  const from = path.join(legacy, 'Local Storage');
  if (fs.existsSync(from) && !fs.existsSync(path.join(here, 'Local Storage'))) {
    fs.mkdirSync(here, { recursive: true });
    fs.cpSync(from, path.join(here, 'Local Storage'), { recursive: true });
    console.log('carried settings over from', legacy);
  }
} catch (e) {
  console.warn('could not carry the old settings over:', e.message);
}
function createWindow() {
  const win = new BrowserWindow({ width: 1500, height: 950, title: 'CNC Studio', backgroundColor: '#1e2126', webPreferences: { contextIsolation: true } });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'app', 'CNCStudio.html'));
  // every export (TAP / DXF / project) opens a Save As dialog
  session.defaultSession.on('will-download', (event, item) => {
    const ext = path.extname(item.getFilename()).replace('.', '');
    item.setSaveDialogOptions({ title: 'Save ' + item.getFilename(), defaultPath: item.getFilename(), filters: [{ name: ext.toUpperCase() + ' file', extensions: [ext] }, { name: 'All files', extensions: ['*'] }] });
  });
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
