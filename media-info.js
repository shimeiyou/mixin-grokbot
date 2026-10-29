'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'weba',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/json': 'json', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'text/html': 'html',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
Object.assign(MIME, { jpeg: 'image/jpeg', txt: 'text/plain', wav: 'audio/wav', oga: 'audio/ogg', m4v: 'video/mp4' });

const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();
const extForMime = (m) => EXT[baseMime(m)] || 'bin';
const mimeForPath = (p) => MIME[path.extname(String(p)).slice(1).toLowerCase()] || 'application/octet-stream';

function sniffMime(b) {
  if (!b || b.length < 4) return null;
  const s = (o, str) => b.length >= o + str.length && b.toString('latin1', o, o + str.length) === str;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s(0, '\x89PNG')) return 'image/png';
  if (s(0, 'GIF8')) return 'image/gif';
  if (s(0, 'RIFF') && s(8, 'WEBP')) return 'image/webp';
  if (s(0, 'RIFF') && s(8, 'WAVE')) return 'audio/wav';
  if (s(0, 'OggS')) return 'audio/ogg';
  if (s(0, '%PDF')) return 'application/pdf';
  if (s(4, 'ftyp')) { const brand = b.toString('latin1', 8, 12); if (/^(M4A |M4B )/.test(brand)) return 'audio/mp4'; if (/^(heic|heix|mif1)/.test(brand)) return 'image/heic'; if (brand === 'qt  ') return 'video/quicktime'; return 'video/mp4'; }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (s(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (s(0, 'PK\x03\x04')) return 'application/zip';
  return null;
}

function imageSize(b) {
  try {
    const m = sniffMime(b);
    if (m === 'image/png') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (m === 'image/gif') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (m === 'image/webp') {
      const f = b.toString('latin1', 12, 16);
      if (f === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (f === 'VP8L') { const n = b.readUInt32LE(21); return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 }; }
      if (f === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    }
    if (m === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch (_) {}
  return null;
}

const hasBin = (bin) => { try { execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 }); return true; } catch (_) { return false; } };
function probe(file) {
  try {
    const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { timeout: 20000, maxBuffer: 4 << 20 }).toString());
    const v = (out.streams || []).find((s) => s.codec_type === 'video');
    const a = (out.streams || []).find((s) => s.codec_type === 'audio');
    const dur = parseFloat((out.format && out.format.duration) || (v && v.duration) || (a && a.duration) || '0');
    return { width: v ? v.width : 0, height: v ? v.height : 0, duration_ms: Math.round((dur || 0) * 1000), video_codec: v && v.codec_name, audio_codec: a && a.codec_name, format: out.format && out.format.format_name };
  } catch (_) { return null; }
}
function thumbnailB64(file, { seekS = 0, size = 64 } = {}) {
  try {
    const buf = execFileSync('ffmpeg', ['-v', 'error', ...(seekS ? ['-ss', String(seekS)] : []), '-i', file, '-frames:v', '1', '-vf', `scale=${size}:-2`, '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '8', 'pipe:1'], { timeout: 20000, maxBuffer: 1 << 20 });
    return buf.length ? buf.toString('base64') : null;
  } catch (_) { return null; }
}

const humanSize = (n) => { n = Number(n) || 0; if (n < 1024) return `${n}B`; if (n < 1 << 20) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`; return `${(n / 1048576).toFixed(1)}MB`; };
module.exports = { EXT, extForMime, mimeForPath, baseMime, sniffMime, imageSize, probe, thumbnailB64, hasBin, humanSize };
