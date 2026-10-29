'use strict';

const fs = require('fs');
const path = require('path');

const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

function fsyncDir(d) {
  try {
    const fd = fs.openSync(d, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {}
}

function writeAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function createQueueStore(q, log) {
  const recs = new Map();
  const sent = new Set();
  let sentLines = 0;
  let totalBytes = 0;

  const fileOf = (id) => path.join(q.dir, `${id}.json`);
  const deadDir = () => path.join(q.dir, 'dead');
  const sentFile = () => path.join(q.dir, 'sent-ids.txt');

  function persist(e) {
    const data = JSON.stringify(e.rec);
    writeAtomic(fileOf(e.rec.id), data);
    totalBytes += Buffer.byteLength(data) - e.bytes;
    e.bytes = Buffer.byteLength(data);
  }

  function addRecord(id, rec, data, bytes) {
    writeAtomic(fileOf(id), data);
    recs.set(id, { rec, bytes, busy: false });
    totalBytes += bytes;
  }

  function unlinkRec(id) {
    const e = recs.get(id);
    if (!e) return;
    recs.delete(id);
    totalBytes -= e.bytes;
    try {
      fs.unlinkSync(fileOf(id));
    } catch (_) {}
    fsyncDir(q.dir);
  }

  function toDead(e, why) {
    const id = e.rec.id;
    try {
      const d = deadDir();
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      e.rec.dead_reason = why;
      e.rec.dead_at = new Date().toISOString();
      e.rec.priv = null;
      writeAtomic(path.join(d, `${id}.json`), JSON.stringify(e.rec));
      const fsd = fs
        .readdirSync(d)
        .filter((f) => /^[A-Za-z0-9_.-]+\.json$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t);
      while (fsd.length > q.deadMax) {
        fs.unlinkSync(path.join(d, fsd.shift().f));
      }
    } catch (err) {
      log(`WARN queue dead-letter write failed msg=${id} err=${err.message}`);
    }
    unlinkRec(id);
  }

  function compactSent() {
    const keep = [...sent].slice(-q.sentKeep);
    sent.clear();
    keep.forEach((x) => sent.add(x));
    try {
      writeAtomic(sentFile(), keep.join('\n') + (keep.length ? '\n' : ''));
      sentLines = keep.length;
    } catch (e) {
      log(`WARN sent-ids compact failed err=${e.message}`);
    }
  }

  function loadSent() {
    let lines = [];
    try {
      lines = fs.readFileSync(sentFile(), 'utf8').split('\n').filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x));
    } catch (_) {}
    for (const x of lines.slice(-q.sentKeep)) sent.add(x);
    sentLines = lines.length;
    if (sentLines > 2 * q.sentKeep) compactSent();
  }

  function markSent(ids) {
    const fresh = [...new Set(ids.map(safeId))].filter((x) => x && !sent.has(x));
    if (!fresh.length) return;
    fresh.forEach((x) => sent.add(x));
    try {
      const fd = fs.openSync(sentFile(), 'a', 0o600);
      try {
        fs.writeSync(fd, fresh.join('\n') + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      sentLines += fresh.length;
    } catch (e) {
      log(`WARN sent-ids append failed err=${e.message}`);
    }
    if (sentLines > 2 * q.sentKeep) compactSent();
  }

  function load() {
    fs.mkdirSync(q.dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(q.dir, 0o700);
    } catch (_) {}
    let n = 0;
    for (const f of fs.readdirSync(q.dir)) {
      const p = path.join(q.dir, f);
      if (/^\..+\.\d+\.tmp$/.test(f)) {
        try {
          fs.unlinkSync(p);
        } catch (_) {}
        continue;
      }
      if (!/^[A-Za-z0-9_-]+\.json$/.test(f)) continue;
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const rec = JSON.parse(raw);
        if (!rec || !rec.id || !rec.payload) throw new Error('bad record');
        rec.next_at = Math.min(rec.next_at || 0, Date.now() + q.maxBackoffMs);
        const sz = Buffer.byteLength(raw);
        recs.set(rec.id, { rec, bytes: sz, busy: false });
        totalBytes += sz;
        n++;
      } catch (e) {
        log(`WARN queue corrupt record ${f} err=${e.message} -> dead/`);
        try {
          fs.mkdirSync(deadDir(), { recursive: true, mode: 0o700 });
          fs.renameSync(p, path.join(deadDir(), f.replace(/\.json$/, '.corrupt.json')));
        } catch (_) {}
      }
    }
    for (const e of recs.values()) {
      const r = e.rec;
      const le = r.held_by && recs.get(r.held_by);
      if (r.held_by && !(le && le.rec.group && !le.rec.group.flushed && le.rec.group.members.includes(r.id))) {
        delete r.held_by;
        r.next_at = Date.now();
      }
      if (r.group && !r.group.flushed) r.next_at = Math.min(r.next_at, Date.now());
    }
    if (n) log(`queue loaded pending=${n} bytes=${totalBytes}`);
  }

  return {
    recs,
    sent,
    getBytes: () => totalBytes,
    persist,
    addRecord,
    unlinkRec,
    toDead,
    load,
    loadSent,
    markSent,
  };
}

module.exports = { safeId, writeAtomic, createQueueStore };
