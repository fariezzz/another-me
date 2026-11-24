/**
 * Utilitas Pengurai & Pengambil Grafik Emoji Berwarna (Twemoji SVG)
 * Digunakan agar emoji di dalam perintah meme (!cap) tampil penuh warna secara konsisten
 * di Windows maupun Linux (karena librsvg bawaan Sharp merender font emoji sistem secara monokrom).
 *
 * Sumber grafik vektor sumber terbuka resmi (lisensi CC-BY 4.0 / MIT):
 * 1. https://github.com/jdecked/twemoji (fork resmi yang dikelola pengelola asli Twemoji)
 * 2. https://github.com/twitter/twemoji (rilis arsip resmi versi 14.0.2)
 *
 * Setiap berkas SVG emoji yang pernah diambil disimpan di memori dan cache lokal (data/emoji-cache/)
 * agar pemakaian berikutnya bekerja instan dan tetap jalan meski offline.
 */

const fs = require('fs');
const path = require('path');

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// Cocok hanya dengan emoji visual sejati (Extended Pictographic, bendera Regional Indicator,
// atau tombol angka keycap seperti 1️⃣), TIDAK menangkap angka ASCII 0-9, '#', atau '*'.
const EMOJI_GRAPHEME_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/u;
const SAFE_CODEPOINT_RE = /^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*$/;

const DEFAULT_EMOJI_CACHE_DIR = path.resolve(__dirname, '../../data/emoji-cache');
const MAX_MEMORY_CACHE_ENTRIES = 500;
const MAX_EMOJI_SVG_BYTES = 128 * 1024; // 128 Kilobyte batas aman per ikon SVG
const DEFAULT_FETCH_TIMEOUT_MS = 3500;

const TWEMOJI_SVG_BASE_URLS = [
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg',
  'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg'
];

const memorySvgCache = new Map();

/**
 * Memecah string menjadi daftar grapheme Unicode utuh (menjaga urutan ZWJ, variasi warna kulit, bendera).
 */
function splitGraphemes(text) {
  return Array.from(graphemeSegmenter.segment(String(text || '')), (item) => item.segment);
}

/**
 * Menentukan apakah satu grapheme merupakan emoji visual sejati.
 */
function isEmojiGrapheme(grapheme) {
  return EMOJI_GRAPHEME_RE.test(String(grapheme || ''));
}

/**
 * Mengecek cepat apakah teks mengandung minimal satu emoji.
 */
function hasEmoji(text) {
  return EMOJI_GRAPHEME_RE.test(String(text || ''));
}

/**
 * Mengonversi satu grapheme emoji menjadi kandidat nama berkas codepoint heksadesimal Twemoji.
 * Contoh:
 * - '😹'   -> ['1f639']
 * - '❤️'   -> ['2764', '2764-fe0f']
 * - '❤️‍🔥' -> ['2764-fe0f-200d-1f525', '2764-200d-1f525']
 * - '1️⃣'  -> ['31-20e3', '31-fe0f-20e3']
 */
function emojiToTwemojiCandidates(grapheme) {
  const codepoints = Array.from(String(grapheme || '')).map((ch) =>
    ch.codePointAt(0).toString(16).toLowerCase()
  );
  if (codepoints.length === 0) return [];

  const hasZwj = codepoints.includes('200d');
  const withFe0f = codepoints.join('-');
  const withoutFe0f = codepoints.filter((cp) => cp !== 'fe0f').join('-');

  const rawList = hasZwj ? [withFe0f, withoutFe0f] : [withoutFe0f, withFe0f];
  const uniqueSafe = [];
  for (const candidate of rawList) {
    if (candidate && SAFE_CODEPOINT_RE.test(candidate) && !uniqueSafe.includes(candidate)) {
      uniqueSafe.push(candidate);
    }
  }
  return uniqueSafe;
}

/**
 * Memecah satu baris teks menjadi segmen terurut antara teks biasa dan emoji.
 */
function splitLineIntoRuns(line) {
  const runs = [];
  let textBuf = '';

  for (const segment of splitGraphemes(line)) {
    if (isEmojiGrapheme(segment)) {
      if (textBuf) {
        runs.push({ type: 'text', value: textBuf });
        textBuf = '';
      }
      runs.push({
        type: 'emoji',
        value: segment,
        candidates: emojiToTwemojiCandidates(segment)
      });
    } else {
      textBuf += segment;
    }
  }

  if (textBuf) {
    runs.push({ type: 'text', value: textBuf });
  }
  return runs;
}

function isValidSvgBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_EMOJI_SVG_BYTES) {
    return false;
  }
  const head = buf.subarray(0, 256).toString('utf-8').trimStart();
  return head.startsWith('<svg') || head.startsWith('<?xml');
}

function setMemoryCache(key, value) {
  if (memorySvgCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = memorySvgCache.keys().next().value;
    if (oldestKey !== undefined) {
      memorySvgCache.delete(oldestKey);
    }
  }
  memorySvgCache.set(key, value);
}

function tryReadDiskCache(cacheDir, cp) {
  if (!cacheDir || !SAFE_CODEPOINT_RE.test(cp)) return null;
  try {
    const filePath = path.join(cacheDir, `${cp}.svg`);
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return isValidSvgBuffer(buf) ? buf : null;
  } catch {
    return null;
  }
}

function tryWriteDiskCache(cacheDir, cp, svgBuf) {
  if (!cacheDir || !SAFE_CODEPOINT_RE.test(cp) || !isValidSvgBuffer(svgBuf)) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, `${cp}.svg`);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, svgBuf);
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Gagal menulis cache disk tidak boleh menggagalkan render gambar
  }
}

/**
 * Mengambil buffer SVG emoji berwarna dari cache memori, cache disk, atau jaringan resmi Twemoji.
 * Mengembalikan null secara aman jika tidak ditemukan atau perangkat sedang offline total.
 */
async function fetchEmojiSvgBuffer(
  candidates,
  {
    cacheDir = DEFAULT_EMOJI_CACHE_DIR,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    useMemoryCache = true
  } = {}
) {
  const safeCandidates = Array.isArray(candidates)
    ? candidates.filter((cp) => SAFE_CODEPOINT_RE.test(cp))
    : [];
  if (safeCandidates.length === 0) return null;

  const primaryKey = safeCandidates[0];
  if (useMemoryCache && memorySvgCache.has(primaryKey)) {
    return memorySvgCache.get(primaryKey);
  }

  for (const cp of safeCandidates) {
    const fromDisk = tryReadDiskCache(cacheDir, cp);
    if (fromDisk) {
      if (useMemoryCache) setMemoryCache(primaryKey, fromDisk);
      return fromDisk;
    }
  }

  if (typeof fetchImpl !== 'function') {
    return null;
  }

  for (const baseUrl of TWEMOJI_SVG_BASE_URLS) {
    for (const cp of safeCandidates) {
      try {
        const res = await fetchImpl(`${baseUrl}/${cp}.svg`, {
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res || !res.ok) continue;
        const arrBuf = await res.arrayBuffer();
        const svgBuf = Buffer.from(arrBuf);
        if (!isValidSvgBuffer(svgBuf)) continue;

        tryWriteDiskCache(cacheDir, cp, svgBuf);
        if (useMemoryCache) setMemoryCache(primaryKey, svgBuf);
        return svgBuf;
      } catch {
        // Lanjut ke kandidat atau mirror berikutnya jika timeout/galat jaringan
      }
    }
  }

  return null;
}

function clearEmojiMemoryCache() {
  memorySvgCache.clear();
}

module.exports = {
  DEFAULT_EMOJI_CACHE_DIR,
  TWEMOJI_SVG_BASE_URLS,
  splitGraphemes,
  isEmojiGrapheme,
  hasEmoji,
  emojiToTwemojiCandidates,
  splitLineIntoRuns,
  isValidSvgBuffer,
  fetchEmojiSvgBuffer,
  clearEmojiMemoryCache
};
