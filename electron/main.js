const { app, BrowserWindow, dialog, session } = require('electron');
const path = require('path');
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
