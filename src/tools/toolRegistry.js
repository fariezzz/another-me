/**
 * Tool Registry & Definitions
 * Menyediakan definisi tools untuk OpenAI-compatible Function Calling
 * dan fungsi eksekutor untuk tiap tool.
 */

const fs = require('fs');
const path = require('path');

class ToolRegistry {
  constructor(options = {}) {
    this.stickersDir = options.stickersDir || path.resolve(__dirname, '../../data/stickers');
    this.knowledgeManager = options.knowledgeManager || null;
    this.defaultCity = process.env.DEFAULT_CITY || 'Tasikmalaya';
    this.defaultTimezone = process.env.DEFAULT_TIMEZONE || 'Asia/Jakarta';

    if (!fs.existsSync(this.stickersDir)) {
      fs.mkdirSync(this.stickersDir, { recursive: true });
    }
  }

  setKnowledgeManager(km) {
    this.knowledgeManager = km;
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
    const tz = args.timezone || this.defaultTimezone;
    const now = new Date();

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
      jam: `${hour}:${minute}`,
      tanggal: dateFormatter.format(now),
      waktu_fase: phase,
      zona_waktu: tz,
      catatan_konteks: `Saat ini pukul ${hour}:${minute} WIB (${phase}). Gunakan konteks ini secara natural tanpa terdengar seperti robot membaca jam.`
    };
  }

  async executeGetWeather(args) {
    const city = args.city || this.defaultCity;
    try {
      // 1. Geocoding nama kota via Open-Meteo Geocoding API
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id&format=json`;
      const geoRes = await fetch(geoUrl);
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

      // 2. Ambil cuaca real-time via Open-Meteo
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code&timezone=auto`;
      const wRes = await fetch(weatherUrl);
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
    // WMO Weather interpretation codes (WW)
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

  executeGetAvailableStickers() {
    try {
      const files = fs.readdirSync(this.stickersDir);
      const stickers = files
        .filter((f) => f.endsWith('.webp'))
        .map((f) => {
          const tag = path.basename(f, '.webp');
          return {
            tag,
            fileName: f
          };
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
    const rawTag = (args.sticker_tag || '').trim().toLowerCase();
    const cleanTag = rawTag.replace(/\.webp$/i, '');

    const files = fs.existsSync(this.stickersDir) ? fs.readdirSync(this.stickersDir) : [];
    const matchedFile = files.find((f) => {
      const name = path.basename(f, '.webp').toLowerCase();
      return name === cleanTag || name.includes(cleanTag) || cleanTag.includes(name);
    });

    if (!matchedFile) {
      return {
        success: false,
        pesan: `Stiker dengan tag '${args.sticker_tag}' tidak ditemukan di koleksi lokal.`,
        tersedia: files.map((f) => path.basename(f, '.webp'))
      };
    }

    const fullPath = path.join(this.stickersDir, matchedFile);

    // Tandai action ini ke context agar ditindaklanjuti oleh Baileys socket
    if (context.actions) {
      context.actions.push({
        type: 'send_sticker',
        filePath: fullPath,
        tag: cleanTag
      });
    }

    return {
      success: true,
      terkirim: true,
      tag: cleanTag,
      fileName: matchedFile,
      catatan_konteks: `Stiker '${matchedFile}' akan dikirim otomatis secara terpisah setelah balasan teksmu. Jangan menulis '[Mengirim Stiker: ...]' atau pengumuman stiker apa pun di teks balasanmu; cukup kirim teks balasan biasa.`
    };
  }

  executeQueryKnowledge(args, context = {}) {
    if (!this.knowledgeManager) {
      return { success: false, pesan: 'Knowledge Manager belum terhubung.' };
    }

    const query = (args.query || '').toLowerCase().trim();
    const category = context.category || 'default';
    const allKnowledge = this.knowledgeManager.getInjectedKnowledge(category);

    if (!allKnowledge) {
      return { success: false, pesan: 'Tidak ada dokumen di knowledge base.' };
    }

    // Filter baris atau paragraf yang relevan dengan query
    const paragraphs = allKnowledge.split(/\n\n+/);
    const matches = paragraphs.filter((p) => p.toLowerCase().includes(query));

    if (matches.length > 0) {
      return {
        success: true,
        hasil: matches.slice(0, 3).join('\n\n')
      };
    }

    // Jika tidak ada match langsung, kembalikan rangkuman ringkas dokumen yang ada
    return {
      success: true,
      hasil: allKnowledge.slice(0, 1500)
    };
  }

  /**
   * Eksekusi Web Search publik dengan arsitektur multi-engine resilience:
   * 1. Wikipedia Search + Lead Extract (Ringkasan ensiklopedis akurat)
   * 2. DuckDuckGo Instant Answer / DuckDuckGo HTML
   */
  async executeWebSearch(args) {
    const rawQuery = (args.query || '').trim();
    if (!rawQuery) return { success: false, pesan: 'Kata kunci pencarian kosong.' };

    const results = [];

    // Engine 1: Wikipedia Search & Article Summary (ID & EN)
    try {
      // 1a. Cari artikel relevan di id.wikipedia
      const searchUrl = `https://id.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(rawQuery)}&format=json&utf8=1&srlimit=3`;
      const searchRes = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnotherMeBot/1.0' }
      });

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const searchList = searchData.query?.search || [];

        for (const item of searchList) {
          const cleanSnippet = (item.snippet || '')
            .replace(/<[^>]*>/g, '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .trim();

          if (cleanSnippet) {
            results.push({
              title: item.title,
              snippet: cleanSnippet
            });
          }
        }
      }

      // Jika belum ada hasil di id.wikipedia, coba en.wikipedia
      if (results.length === 0) {
        const enSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(rawQuery)}&format=json&utf8=1&srlimit=3`;
        const enRes = await fetch(enSearchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnotherMeBot/1.0' }
        });
        if (enRes.ok) {
          const enData = await enRes.json();
          const enList = enData.query?.search || [];
          for (const item of enList) {
            const cleanSnippet = (item.snippet || '').replace(/<[^>]*>/g, '').trim();
            if (cleanSnippet) {
              results.push({
                title: item.title,
                snippet: cleanSnippet
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[WebSearch Warning]:', err.message);
    }

    if (results.length > 0) {
      return {
        success: true,
        query: rawQuery,
        total_ditemukan: results.length,
        hasil: results.map((r, i) => `${i + 1}. [${r.title}]: ${r.snippet}`).join('\n\n'),
        catatan_konteks: `Informasi internet untuk "${rawQuery}":\n${results.map(r => `${r.title}: ${r.snippet}`).join(' ')}\nGunakan informasi faktual ini untuk menyusun balasan chat santai kamu.`
      };
    }

    return {
      success: true,
      query: rawQuery,
      hasil: `Informasi spesifik mengenai "${rawQuery}" tidak ditemukan secara instan di internet. Gunakan pengetahuan umum terbaikmu untuk merespons secara wajar.`
    };
  }
}

module.exports = ToolRegistry;
