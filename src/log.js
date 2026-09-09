/* ===== log.js — activity log: actions, warnings, errors =====
   Loaded first so it can capture failures that happen during startup.
   Entries survive a restart (localStorage), so if the app misbehaves and you
   close it, the log is still there when you reopen. */
const LOG = (() => {
  const MAX = 600;                 // ring buffer size
  const KEY = 'cncstudio.log';
  let entries = [];
  const subs = [];

  try { const j = JSON.parse(localStorage.getItem(KEY) || '[]'); if (Array.isArray(j)) entries = j.slice(-MAX); } catch (e) { }

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(entries.slice(-MAX))); } catch (e) { } }, 400);
  }

  function push(level, msg, detail) {
    const e = { t: Date.now(), level, msg: String(msg), detail: detail === undefined ? '' : stringify(detail) };
    entries.push(e);
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    persist();
    subs.forEach(fn => { try { fn(e); } catch (_) { } });
    return e;
  }
  function stringify(d) {
    if (d == null) return '';
    if (typeof d === 'string') return d;
    if (d instanceof Error) return (d.stack || d.message || String(d));
    try { return JSON.stringify(d); } catch (e) { return String(d); }
  }

  const api = {
    action: (m, d) => push('action', m, d),   // user did something that changed the job
    info: (m, d) => push('info', m, d),
    warn: (m, d) => push('warn', m, d),
    error: (m, d) => push('error', m, d),
    entries: () => entries.slice(),
    counts: () => entries.reduce((a, e) => (a[e.level] = (a[e.level] || 0) + 1, a), {}),
    clear: () => { entries = []; try { localStorage.removeItem(KEY); } catch (e) { } subs.forEach(fn => { try { fn(null); } catch (_) { } }); },
    subscribe: (fn) => { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
    toText: () => entries.map(e =>
      `${new Date(e.t).toISOString()}  ${e.level.toUpperCase().padEnd(6)} ${e.msg}${e.detail ? '\n        ' + e.detail.replace(/\n/g, '\n        ') : ''}`
    ).join('\n'),
    // wrap a function so any throw is logged (and re-thrown) instead of vanishing
    guard: (name, fn) => function (...a) {
      try { return fn.apply(this, a); }
      catch (err) { push('error', `${name} failed: ${err.message}`, err); throw err; }
    },
  };

  // ---- capture the things that would otherwise disappear into devtools
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (ev) => {
      if (ev.error) push('error', ev.message, ev.error);
      else push('error', ev.message || 'script error', `${ev.filename || ''}:${ev.lineno || 0}`);
    });
    window.addEventListener('unhandledrejection', (ev) => push('error', 'Unhandled promise rejection', ev.reason));
    for (const lvl of ['warn', 'error']) {
      const orig = console[lvl].bind(console);
      console[lvl] = (...a) => {
        // don't recurse if our own persist/render path logs
        try { push(lvl, a.map(x => typeof x === 'string' ? x : stringify(x)).join(' ')); } catch (_) { }
        orig(...a);
      };
    }
  }
  return api;
})();
if (typeof module !== 'undefined') module.exports = LOG;
