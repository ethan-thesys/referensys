/* A tiny key-value store in IndexedDB, shared by the extension's background worker and its pages.
   Recorded screenshots wait here until the editor picks them up (they're too big for chrome.storage). */
(function (g) {
  'use strict';
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('referensys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  }));
  const run = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction('kv', mode), s = t.objectStore('kv');
    const r = fn(s);
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  }));
  g.kv = {
    get: k => run('readonly', s => s.get(k)),
    set: (k, v) => run('readwrite', s => { s.put(v, k); }),
    del: k => run('readwrite', s => { s.delete(k); })
  };
})(self);
