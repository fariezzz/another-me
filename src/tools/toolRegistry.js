/**
 * Tool Registry & Definitions
 * Menyediakan definisi tools untuk OpenAI-compatible Function Calling
 * dan fungsi eksekutor untuk tiap tool.
 */

const fs = require('fs');
const path = require('path');

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Memotong teks panjang secara bersih pada batas kalimat (atau batas kata utuh)
 * agar tidak pernah terpotong menggantung di tengah kalimat seperti snippet mentah.
 */
function trimToCleanSentences(text, maxChars = 420) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length <= maxChars) return normalized;

  const slice = normalized.slice(0, maxChars);
  const lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastSentenceEnd >= Math.floor(maxChars * 0.45)) {
    return slice.slice(0, lastSentenceEnd + 1).trim();
  }

  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:\-]+$/, '').trim()}...`;
}

/**
 * Menghapus awalan kata tanya agar pencarian ensiklopedia (Wikipedia) lebih tepat sasaran.
 * Contoh: "Siapa presiden indonesia?" -> "presiden indonesia".
 */
function cleanSearchQueryForEncyclopedia(rawQuery) {
  let cleaned = String(rawQuery || '').trim().replace(/[?!.]+$/g, '').trim();
  if (!cleaned) return '';

  cleaned = cleaned
    .replace(
      /^(?:siapakah|siapa|apakah|apa|kapankah|kapan|dimanakah|dimana|di\s+manakah|di\s+mana|bagaimanakah|bagaimana|mengapa|kenapa|berapakah|berapa|jelaskan|ceritakan|carikan|cari|informasi\s+tentang|info\s+tentang|who\s+is|who\s+was|what\s+is|what\s+are|where\s+is|when\s+is|when\s+was|tell\s+me\s+about)\s+/i,
      ''
    )
    .replace(/^(?:yang|itu|adalah|tentang|mengenai|nama|the|a|an)\s+/i, '')
    .trim();

  return cleaned.length >= 2 ? cleaned : String(rawQuery || '').trim();
}

/**
 * Mengekstrak entitas inti di belakang preposisi relasi (mis. "suami dari Carlotta Montelli" -> "Carlotta Montelli")
 * sebagai fallback pencarian kedua ketika kueri lengkap tidak menghasilkan temuan.
 */
function extractFallbackEntityQuery(cleanedQuery) {
  const text = String(cleanedQuery || '').trim();
  if (!text) return '';

  const relMatch = text.match(/(?:\bdari\b|\bof\b|\btentang\b|\bmengenai\b)\s+(.+)$/i);
  if (relMatch && relMatch[1]) {
    const entity = relMatch[1].replace(/[?!.]+$/g, '').trim();
    if (entity.length >= 2 && entity.toLowerCase() !== text.toLowerCase()) {
      return entity;
    }
  }
  return '';
}

function formatRssPubDate(rawPubDate) {
  if (!rawPubDate) return '';
  const parsed = new Date(rawPubDate);
  if (Number.isNaN(parsed.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Jakarta'
    }).format(parsed);
  } catch {
    return '';
  }
}

class ToolRegistry {
  constructor(options = {}) {
    this.stickersDir = options.stickersDir || path.resolve(__dirname, '../../data/stickers');
    this.knowledgeManager = options.knowledgeManager || null;
    this.defaultCity = process.env.DEFAULT_CITY || 'Tasikmalaya';
    this.defaultTimezone = process.env.DEFAULT_TIMEZONE || 'Asia/Jakarta';
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 8000;
    this.ddgTimeoutMs = options.ddgTimeoutMs ?? Math.min(this.fetchTimeoutMs, 3000);
    this.ddgCooldownMs = options.ddgCooldownMs ?? 10 * 60 * 1000;
    this.ddgCooldownUntil = 0;

    if (!fs.existsSync(this.stickersDir)) {
      fs.mkdirSync(this.stickersDir, { recursive: true });
    }
  }

  /**
   * Skema OpenAI Function Calling Tools
   */
  getToolDefinitions() {
    return [
      {
        type: 'function',
        function: {
          name: 'get_current_time',
          description: 'Mendapatkan waktu, jam, menit, hari, tanggal, dan fase waktu (pagi/siang/sore/malam) saat ini secara akurat di zona waktu lokal pengguna.',
          parameters: {
            type: 'object',
            properties: {
              timezone: {
                type: 'string',
                description: 'Zona waktu IANA, default: Asia/Jakarta'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Mengecek kondisi cuaca terkini, suhu, kelembaban, dan probabilitas hujan real-time untuk kota tertentu (misal: Tasikmalaya, Bandung, Jakarta).',
          parameters: {
            type: 'object',
            properties: {
              city: {
                type: 'string',
                description: 'Nama kota yang ingin dicek cuacanya, contoh: Tasikmalaya, Bandung, Jakarta'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_available_stickers',
          description: 'Melihat daftar stiker WhatsApp yang tersedia di koleksi lokal beserta tag emosinya (misal: ketawa, sedih, manja, peluk, ngambek).',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'send_sticker',
          description: 'Memilih dan mengirimkan sebuah stiker WhatsApp dari koleksi ke lawan bicara berdasarkan tag emosi atau nama stiker yang cocok dengan obrolan.',
          parameters: {
            type: 'object',
            properties: {
              sticker_tag: {
                type: 'string',
                description: 'Nama file atau tag stiker yang ingin dikirim (misal: "ketawa", "peluk", "gemes", "ngambek", "love")'
              }
            },
            required: ['sticker_tag']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'query_knowledge',
          description: 'Mencari informasi spesifik dari basis pengetahuan pribadi (jadwal kuliah, preferensi, agenda, catatan pribadi).',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Kata kunci atau hal yang ingin dicari informasinya'
              }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Melakukan pencarian informasi terkini di internet / web (berita terbaru, fakta umum, info tempat, rekomendasi, definisi, skor pertandingan, jadwal rilis film/anime, dll).',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Kata kunci pencarian web, contoh: "jadwal tayang anime X 2026", "skor indonesia vs jepang", "kafe hits tasikmalaya"'
              }
            },
            required: ['query']
          }
        }
      }
    ];
  }

  /**
   * Eksekusi tool berdasarkan nama dan arguments
   */
  async executeTool(name, args = {}, context = {}) {
    switch (name) {
      case 'get_current_time':
        return this.executeGetCurrentTime(args);
      case 'get_weather':
        return await this.executeGetWeather(args);
      case 'get_available_stickers':
        return this.executeGetAvailableStickers();
      case 'send_sticker':
        return this.executeSendSticker(args, context);
      case 'query_knowledge':
        return this.executeQueryKnowledge(args, context);
      case 'web_search':
        return await this.executeWebSearch(args);
      default:
        return { error: `Tool '${name}' tidak dikenali.` };
    }
  }

  executeGetCurrentTime(args) {
    let tz = args.timezone || this.defaultTimezone;
    const now = new Date();

    // Validasi zona waktu agar input salah dari LLM tidak melempar RangeError
    try {
      new Intl.DateTimeFormat('id-ID', { timeZone: tz });
    } catch {
      tz = this.defaultTimezone;
    }

    const timeFormatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });

    const dateFormatter = new Intl.DateTimeFormat('id-ID', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    const parts = timeFormatter.formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
    const minute = parts.find((p) => p.type === 'minute')?.value || '00';

    let phase = 'malam';
    if (hour >= 4 && hour < 10) phase = 'pagi';
    else if (hour >= 10 && hour < 15) phase = 'siang';
    else if (hour >= 15 && hour < 18) phase = 'sore';

    return {
      success: true,
      jam: `${String(hour).padStart(2, '0')}:${minute}`,
      tanggal: dateFormatter.format(now),
      waktu_fase: phase,
      zona_waktu: tz,
      catatan_konteks: `Saat ini pukul ${String(hour).padStart(2, '0')}:${minute} (${tz}, ${phase}). Gunakan konteks ini secara natural tanpa terdengar seperti robot membaca jam.`
    };
  }

  async executeGetWeather(args) {
    const city = args.city || this.defaultCity;
    try {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id&format=json`;
      const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(this.fetchTimeoutMs) });
      if (!geoRes.ok) throw new Error('Gagal menghubungi service geocoding');
      const geoData = await geoRes.json();

      if (!geoData.results || geoData.results.length === 0) {
        return {
          success: false,
          kota: city,
          pesan: `Lokasi '${city}' tidak ditemukan.`
        };
      }

      const loc = geoData.results[0];
      const { latitude, longitude, name: resolvedName } = loc;

      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code&timezone=auto`;
      const wRes = await fetch(weatherUrl, { signal: AbortSignal.timeout(this.fetchTimeoutMs) });
      if (!wRes.ok) throw new Error('Gagal mengambil data prakiraan cuaca');
      const wData = await wRes.json();

      const cur = wData.current || {};
      const weatherDesc = this.mapWmoCode(cur.weather_code);

      return {
        success: true,
        kota: resolvedName,
        suhu: `${cur.temperature_2m}°C`,
        terasa_seperti: `${cur.apparent_temperature}°C`,
        kondisi: weatherDesc.kondisi,
        sedang_hujan: weatherDesc.hujan,
        kelembaban: `${cur.relative_humidity_2m}%`,
        presipitasi: `${cur.precipitation} mm`,
        catatan_konteks: `Cuaca di ${resolvedName} saat ini: ${weatherDesc.kondisi}, suhu ${cur.temperature_2m}°C (${weatherDesc.hujan ? 'sedang hujan' : 'tidak hujan'}). Balas lawan bicara sesuai kondisi ini secara santai.`
      };
    } catch (err) {
      return {
        success: false,
        kota: city,
        error: err.message,
        catatan_konteks: 'Tidak bisa mengecek cuaca saat ini.'
      };
    }
  }

  mapWmoCode(code) {
    if (code === 0) return { kondisi: 'Cerah', hujan: false };
    if (code === 1 || code === 2) return { kondisi: 'Sebagian Berawan', hujan: false };
    if (code === 3) return { kondisi: 'Mendung Berawan', hujan: false };
    if (code >= 45 && code <= 48) return { kondisi: 'Berkabut', hujan: false };
    if (code >= 51 && code <= 55) return { kondisi: 'Gerimis Ringan', hujan: true };
    if (code >= 61 && code <= 65) return { kondisi: 'Hujan', hujan: true };
    if (code >= 80 && code <= 82) return { kondisi: 'Hujan Deras / Guyuran', hujan: true };
    if (code >= 95) return { kondisi: 'Badai Petir', hujan: true };
    return { kondisi: 'Berawan', hujan: false };
  }

  listWebpFiles() {
    if (!fs.existsSync(this.stickersDir)) return [];
    return fs.readdirSync(this.stickersDir).filter((f) => f.toLowerCase().endsWith('.webp'));
  }

  executeGetAvailableStickers() {
    try {
      const files = this.listWebpFiles();
      const stickers = files.map((f) => {
        const tag = f.replace(/\.webp$/i, '');
        return { tag, fileName: f };
      });

      return {
        success: true,
        total: stickers.length,
        stickers,
        catatan_konteks: stickers.length > 0
          ? `Tersedia stiker: ${stickers.map((s) => s.tag).join(', ')}. Panggil tool send_sticker dengan salah satu tag ini jika ingin mengirim stiker.`
          : 'Belum ada stiker di koleksi lokal.'
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  executeSendSticker(args, context = {}) {
    const rawTag = String(args.sticker_tag || '').trim().toLowerCase();
    const cleanTag = rawTag.replace(/\.webp$/i, '');
    if (!cleanTag) {
      return {
        success: false,
        pesan: 'Tag stiker kosong.',
        tersedia: this.listWebpFiles().map((f) => f.replace(/\.webp$/i, ''))
      };
    }

    const files = this.listWebpFiles();
    const matchedFile = files.find((f) => {
      const name = f.replace(/\.webp$/i, '').toLowerCase();
      return name === cleanTag || name.includes(cleanTag) || cleanTag.includes(name);
    });

    if (!matchedFile) {
      return {
        success: false,
        pesan: `Stiker dengan tag '${args.sticker_tag}' tidak ditemukan di koleksi lokal.`,
        tersedia: files.map((f) => f.replace(/\.webp$/i, ''))
      };
    }

    const fullPath = path.join(this.stickersDir, matchedFile);

    if (context.actions) {
      context.actions.push({
        type: 'send_sticker',
        filePath: fullPath,
        tag: matchedFile.replace(/\.webp$/i, '')
      });
    }

    return {
      success: true,
      terkirim: true,
      tag: matchedFile.replace(/\.webp$/i, ''),
      fileName: matchedFile,
      catatan_konteks: `Stiker '${matchedFile}' akan dikirim otomatis secara terpisah setelah balasan teksmu. Jangan menulis '[Mengirim Stiker: ...]' atau pengumuman stiker apa pun di teks balasanmu; cukup kirim teks balasan biasa.`
    };
  }

  executeQueryKnowledge(args, context = {}) {
    if (!this.knowledgeManager) {
      return { success: false, pesan: 'Knowledge Manager belum terhubung.' };
    }

    const query = String(args.query || '').trim();
    const category = context.category || 'default';
    const allowUniversal = context.allowUniversalKnowledge !== false;

    if (context.isGroup) {
      return { success: false, pesan: 'Catatan pribadi tidak diakses pada percakapan grup publik.' };
    }

    if (typeof this.knowledgeManager.searchKnowledge === 'function') {
      const searched = this.knowledgeManager.searchKnowledge(query, category, 3, { allowUniversal });
      if (!searched) {
        return { success: false, pesan: 'Tidak ditemukan catatan yang cocok di basis pengetahuan.' };
      }
      return { success: true, hasil: searched };
    }

    const allKnowledge = this.knowledgeManager.getInjectedKnowledge(category, query, { allowUniversal });
    if (!allKnowledge) {
      return { success: false, pesan: 'Tidak ada dokumen di knowledge base.' };
    }

    const paragraphs = allKnowledge.split(/\n\n+/);
    const matches = paragraphs.filter((p) => p.toLowerCase().includes(query.toLowerCase()));
    if (matches.length > 0) {
      return { success: true, hasil: matches.slice(0, 3).join('\n\n') };
    }

    return { success: false, pesan: 'Tidak ditemukan catatan yang cocok di basis pengetahuan.' };
  }

  async searchWikipedia(lang, rawQuery) {
    const query = String(rawQuery || '').trim();
    if (!query) return [];

    // Pakai generator=search + prop=extracts|info agar mendapat kalimat pembuka utuh + URL artikel
    // (bukan snippet pendek list=search yang sering terpotong di tengah kalimat).
    const searchUrl =
      `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search` +
      `&gsrsearch=${encodeURIComponent(query)}&gsrlimit=3` +
      `&prop=extracts|info&exintro=1&explaintext=1&exsentences=3&inprop=url&format=json&utf8=1`;

    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnotherMeBot/1.0' },
      signal: AbortSignal.timeout(this.fetchTimeoutMs)
    });
    if (!res.ok) return [];

    const data = await res.json();
    const pagesObj = data.query?.pages || {};
    const pages = Object.values(pagesObj).sort((a, b) => (a.index ?? 999) - (b.index ?? 999));

    const items = [];
    for (const page of pages) {
      const cleanExtract = trimToCleanSentences(decodeHtmlEntities(page.extract || ''), 420);
      if (cleanExtract) {
        items.push({
          source: `Wikipedia (${lang})`,
          title: page.title || query,
          snippet: cleanExtract,
          url: page.canonicalurl || page.fullurl || ''
        });
      }
    }
    return items;
  }

  /**
   * Pencarian berita & fakta terkini lewat umpan publik Really Simple Syndication (RSS) Google News.
   * Dapat diakses cepat dari Indonesia maupun server luar negeri tanpa kunci API.
   */
  async searchGoogleNewsRss(rawQuery) {
    const query = String(rawQuery || '').trim();
    if (!query) return [];

    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=id&gl=ID&ceid=ID:id`;
    try {
      const res = await fetch(rssUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnotherMeBot/1.0' },
        signal: AbortSignal.timeout(Math.min(this.fetchTimeoutMs, 5000))
      });
      if (!res.ok) return [];
      const xml = await res.text();
      const matches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
      const items = [];

      for (const m of matches.slice(0, 3)) {
        const block = m[1];
        const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const rawSource = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || '';
        const rawPubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';

        let title = decodeHtmlEntities(rawTitle);
        const sourceName = decodeHtmlEntities(rawSource);
        const dateLabel = formatRssPubDate(decodeHtmlEntities(rawPubDate));

        // Google News menempelkan " - Nama Media" di akhir judul; bersihkan agar tidak dobel
        if (sourceName && title.endsWith(` - ${sourceName}`)) {
          title = title.slice(0, -(` - ${sourceName}`).length).trim();
        }
        if (!title) continue;

        items.push({
          source: sourceName ? `Berita (${sourceName})` : 'Google News',
          title,
          snippet: dateLabel ? `${title} (${dateLabel}).` : `${title}.`,
          url: ''
        });
      }
      return items;
    } catch (err) {
      console.warn('[WebSearch Google News RSS Warning]:', err.message);
      return [];
    }
  }

  async searchDuckDuckGo(rawQuery) {
    // Jika DuckDuckGo baru saja timeout/diblokir jaringan (umum di Indonesia),
    // lewati sementara selama cooldown agar pencarian tidak melambat.
    if (Date.now() < this.ddgCooldownUntil) return [];

    const items = [];
    let failedCount = 0;

    // 1. DuckDuckGo Instant Answer JSON API
    try {
      const iaUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(rawQuery)}&format=json&no_html=1&skip_disambig=1`;
      const iaRes = await fetch(iaUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnotherMeBot/1.0' },
        signal: AbortSignal.timeout(this.ddgTimeoutMs)
      });
      if (iaRes.ok) {
        const iaData = await iaRes.json();
        if (iaData.AbstractText) {
          items.push({
            source: 'DuckDuckGo',
            title: iaData.Heading || rawQuery,
            snippet: trimToCleanSentences(decodeHtmlEntities(iaData.AbstractText), 420),
            url: iaData.AbstractURL || ''
          });
        }
        if (iaData.Answer) {
          items.push({
            source: 'DuckDuckGo',
            title: rawQuery,
            snippet: decodeHtmlEntities(iaData.Answer),
            url: ''
          });
        }
        if (items.length < 2 && Array.isArray(iaData.RelatedTopics)) {
          for (const topic of iaData.RelatedTopics) {
            if (items.length >= 3) break;
            if (topic && typeof topic.Text === 'string' && topic.Text.trim()) {
              items.push({
                source: 'DuckDuckGo',
                title: topic.FirstURL ? topic.Text.split(' - ')[0].slice(0, 60) : rawQuery,
                snippet: trimToCleanSentences(decodeHtmlEntities(topic.Text), 320),
                url: topic.FirstURL || ''
              });
            }
          }
        }
      }
    } catch (err) {
      failedCount++;
      console.warn('[WebSearch DDG IA Warning]:', err.message);
    }

    if (items.length >= 2) return items;
    if (failedCount > 0) {
      // Langsung aktifkan cooldown jika endpoint pertama gagal jaringan/timeout (DNS block)
      this.ddgCooldownUntil = Date.now() + this.ddgCooldownMs;
      return items;
    }

    // 2. DuckDuckGo HTML Lite (untuk berita, skor, jadwal rilis, tempat terkini di server luar negeri)
    try {
      const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(rawQuery)}`;
      const htmlRes = await fetch(htmlUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        signal: AbortSignal.timeout(this.ddgTimeoutMs)
      });
      if (htmlRes.ok) {
        const html = await htmlRes.text();
        const titleMatches = [...html.matchAll(/class="result__a"[^>]*>([\s\S]*?)<\/a>/gi)];
        const snippetMatches = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/gi)];
        const count = Math.min(3, titleMatches.length, snippetMatches.length);
        for (let i = 0; i < count; i++) {
          const title = decodeHtmlEntities(titleMatches[i][1]);
          const snippet = trimToCleanSentences(decodeHtmlEntities(snippetMatches[i][1]), 320);
          if (title && snippet) {
            items.push({ source: 'DuckDuckGo Web', title, snippet, url: '' });
          }
        }
      }
    } catch (err) {
      this.ddgCooldownUntil = Date.now() + this.ddgCooldownMs;
      console.warn('[WebSearch DDG HTML Warning]:', err.message);
    }

    return items;
  }

  /**
   * Eksekusi Web Search publik dengan arsitektur multi-engine:
   * 1. Wikipedia (kalimat pembuka utuh + URL, Bahasa Indonesia lalu Inggris)
   * 2. Google News RSS (berita & fakta terkini, dapat diakses cepat dari Indonesia maupun global)
   * 3. DuckDuckGo (Instant Answer + Web HTML, dengan fast-fail cooldown bila terblokir lokal)
   */
  async executeWebSearch(args) {
    const rawQuery = String(args.query || '').trim();
    if (!rawQuery) return { success: false, pesan: 'Kata kunci pencarian kosong.' };

    const wikiQuery = cleanSearchQueryForEncyclopedia(rawQuery);
    const fallbackEntityQuery = extractFallbackEntityQuery(wikiQuery);

    // Jalankan DuckDuckGo, Wikipedia Indonesia, dan Google News RSS secara paralel
    const [ddgResults, wikiIdResults, gnewsResults] = await Promise.all([
      this.searchDuckDuckGo(rawQuery).catch(() => []),
      this.searchWikipedia('id', wikiQuery).catch(() => []),
      this.searchGoogleNewsRss(rawQuery).catch(() => [])
    ]);

    const combined = [];
    combined.push(...ddgResults.slice(0, 2));
    combined.push(...wikiIdResults.slice(0, 2));
    combined.push(...gnewsResults.slice(0, 3));

    // Jika belum ada hasil Wikipedia Bahasa Indonesia, coba Wikipedia Bahasa Inggris
    if (wikiIdResults.length === 0) {
      const wikiEnResults = await this.searchWikipedia('en', wikiQuery).catch(() => []);
      combined.push(...wikiEnResults.slice(0, 2));
    }

    // Jika masih kosong dan ada entitas inti di belakang kata hubung (mis. "suami dari Carlotta Montelli" -> "Carlotta Montelli")
    if (combined.length === 0 && fallbackEntityQuery) {
      const [fbWikiId, fbWikiEn, fbGNews] = await Promise.all([
        this.searchWikipedia('id', fallbackEntityQuery).catch(() => []),
        this.searchWikipedia('en', fallbackEntityQuery).catch(() => []),
        this.searchGoogleNewsRss(fallbackEntityQuery).catch(() => [])
      ]);
      combined.push(...fbWikiId.slice(0, 2));
      combined.push(...fbWikiEn.slice(0, 2));
      combined.push(...fbGNews.slice(0, 3));
    }

    // Deduplikasi berdasarkan judul (case-insensitive)
    const seen = new Set();
    const deduped = [];
    for (const item of combined) {
      const key = String(item.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    if (deduped.length > 0) {
      const top = deduped.slice(0, 5);
      return {
        success: true,
        query: rawQuery,
        total_ditemukan: top.length,
        items: top,
        hasil: top
          .map((r, i) => `${i + 1}. [${r.title} - ${r.source}]: ${r.snippet}${r.url ? `\n   ${r.url}` : ''}`)
          .join('\n\n'),
        catatan_konteks: `Informasi internet untuk "${rawQuery}":\n${top.map((r) => `${r.title} (${r.source}): ${r.snippet}`).join('\n')}\nGunakan informasi faktual ini untuk menyusun balasan chat santai kamu.`
      };
    }

    return {
      success: true,
      query: rawQuery,
      total_ditemukan: 0,
      items: [],
      hasil: '',
      catatan_konteks: `Informasi spesifik mengenai "${rawQuery}" tidak ditemukan secara instan di internet. Gunakan pengetahuan umum terbaikmu untuk merespons secara wajar.`
    };
  }
}

ToolRegistry.cleanSearchQueryForEncyclopedia = cleanSearchQueryForEncyclopedia;
ToolRegistry.extractFallbackEntityQuery = extractFallbackEntityQuery;
ToolRegistry.trimToCleanSentences = trimToCleanSentences;

module.exports = ToolRegistry;
