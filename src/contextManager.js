/**
 * Context Manager
 * Mengelola pemetaan profil kontak, kontrol izin auto-reply per kontak,
 * riwayat obrolan (memory), dan penyusunan System Prompt + Few-Shot Examples.
 */

const fs = require('fs');
const path = require('path');

class ContextManager {
  constructor(options = {}) {
    this.dataPath = options.dataPath || path.resolve(__dirname, '../data');
    this.contactsFile = path.join(this.dataPath, 'contacts.json');
    this.personaFile = path.join(this.dataPath, 'persona.json');
    this.memoryFile = path.join(this.dataPath, 'chat_memory.json');

    this.maxHistory = parseInt(process.env.MAX_HISTORY_MESSAGES, 10) || 10;
    this.memory = {};

    this.loadData();
  }

  loadData() {
    try {
      if (!fs.existsSync(this.contactsFile)) {
        const exampleFile = path.join(this.dataPath, 'contacts.example.json');
        if (fs.existsSync(exampleFile)) {
          fs.copyFileSync(exampleFile, this.contactsFile);
        }
      }
      this.contacts = fs.existsSync(this.contactsFile)
        ? JSON.parse(fs.readFileSync(this.contactsFile, 'utf-8')).contacts || {}
        : {};
    } catch (err) {
      console.warn('[ContextManager] Gagal membaca contacts.json:', err.message);
      this.contacts = {};
    }

    try {
      this.persona = fs.existsSync(this.personaFile)
        ? JSON.parse(fs.readFileSync(this.personaFile, 'utf-8'))
        : { general_persona: {}, categories: {} };
    } catch (err) {
      console.warn('[ContextManager] Gagal membaca persona.json:', err.message);
      this.persona = { general_persona: {}, categories: {} };
    }

    try {
      if (fs.existsSync(this.memoryFile)) {
        this.memory = JSON.parse(fs.readFileSync(this.memoryFile, 'utf-8'));
      }
    } catch {
      this.memory = {};
    }
  }

  saveContacts() {
    try {
      const payload = {
        description: 'Daftar pemetaan kontak dan kontrol toggle auto-reply AI.',
        format_note: 'Nomor menggunakan format internasional tanpa tanda + (contoh: 6281234567890).',
        contacts: this.contacts
      };
      fs.writeFileSync(this.contactsFile, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ContextManager] Gagal menyimpan contacts.json:', err.message);
    }
  }

  savePersona() {
    try {
      fs.writeFileSync(this.personaFile, JSON.stringify(this.persona, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ContextManager] Gagal menyimpan persona.json:', err.message);
    }
  }

  getAvailableStickersList() {
    const stickersDir = path.join(this.dataPath, 'stickers');
    if (!fs.existsSync(stickersDir)) return [];
    try {
      return fs.readdirSync(stickersDir)
        .filter(f => f.endsWith('.webp'))
        .map(f => path.basename(f, '.webp'));
    } catch {
      return [];
    }
  }

  /**
   * Mengambil seluruh data persona
   */
  getPersonaData() {
    return this.persona;
  }

  /**
   * Menyimpan / memperbarui persona kategori tertentu
   */
  updateCategoryPersona(categoryKey, data) {
    if (!this.persona.categories) this.persona.categories = {};
    this.persona.categories[categoryKey] = {
      tone: data.tone || '',
      vocabulary: Array.isArray(data.vocabulary) ? data.vocabulary : (data.vocabulary || '').split(',').map((s) => s.trim()).filter(Boolean),
      guidelines: data.guidelines || '',
      few_shots: Array.isArray(data.few_shots) ? data.few_shots : []
    };
    this.savePersona();
    return this.persona.categories[categoryKey];
  }

  /**
   * Update persona umum (identitas & core typing rules)
   */
  updateGeneralPersona({ identity, core_typing_rules }) {
    if (!this.persona.general_persona) this.persona.general_persona = {};
    if (identity !== undefined) this.persona.general_persona.identity = identity;
    if (core_typing_rules !== undefined) {
      this.persona.general_persona.core_typing_rules = Array.isArray(core_typing_rules)
        ? core_typing_rules
        : core_typing_rules.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    this.savePersona();
    return this.persona.general_persona;
  }

  /**
   * Hapus kategori persona
   */
  deleteCategoryPersona(categoryKey) {
    if (this.persona.categories && this.persona.categories[categoryKey]) {
      delete this.persona.categories[categoryKey];
      this.savePersona();
      return true;
    }
    return false;
  }

  saveMemory() {
    try {
      fs.writeFileSync(this.memoryFile, JSON.stringify(this.memory, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ContextManager] Gagal menyimpan chat_memory.json:', err.message);
    }
  }

  /**
   * Menemukan profil kontak berdasarkan nomor telepon atau JID WhatsApp
   * @param {string} senderJid
   * @param {string} [pushName] Nama profil pengirim dari WhatsApp (opsional)
   */
  getContactProfile(senderJid, pushName = '') {
    const phone = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
    const found = this.contacts[phone];

    if (found) {
      return {
        phone,
        name: found.name || pushName || phone,
        pushName: pushName || '',
        category: found.category || 'default',
        enabled: found.enabled !== false, // default true jika terdaftar
        notes: found.notes || '',
        isKnown: true
      };
    }

    return {
      phone,
      name: pushName || phone,
      pushName: pushName || '',
      category: 'default',
      enabled: false, // jika nomor asing dan bukan di contacts, enabled default false jika whitelist aktif
      notes: '',
      isKnown: false
    };
  }

  /**
   * Menentukan apakah pesan dari nomor ini boleh dibalas oleh AI
   * @param {string} senderJid
   * @param {boolean} whitelistOnlyMode
   * @returns {boolean}
   */
  shouldReply(senderJid, whitelistOnlyMode) {
    const profile = this.getContactProfile(senderJid);
    const isRegistered = Boolean(this.contacts[profile.phone]);

    if (whitelistOnlyMode) {
      // Jika whitelist only, nomor harus terdaftar dan enabled = true
      return isRegistered && profile.enabled === true;
    }

    // Jika mode umum (non-whitelist), nomor terdaftar yang dimatikan (enabled = false) TIDAK akan dibalas
    if (isRegistered && profile.enabled === false) {
      return false;
    }

    return true;
  }

  /**
   * Update atau tambah kontak dari dashboard
   * Mendukung pergantian nomor lama ke nomor baru jika diedit
   */
  upsertContact(phone, data, oldPhone = null) {
    const cleanPhone = phone.replace(/\D/g, '');
    const cleanOldPhone = oldPhone ? oldPhone.replace(/\D/g, '') : null;

    if (cleanOldPhone && cleanOldPhone !== cleanPhone) {
      delete this.contacts[cleanOldPhone];
      if (this.memory[cleanOldPhone]) {
        this.memory[cleanPhone] = this.memory[cleanOldPhone];
        delete this.memory[cleanOldPhone];
        this.saveMemory();
      }
    }

    this.contacts[cleanPhone] = {
      name: data.name || cleanPhone,
      category: data.category || 'default',
      enabled: data.enabled !== false,
      notes: data.notes || ''
    };
    this.saveContacts();
    return this.contacts[cleanPhone];
  }

  /**
   * Hapus kontak dari daftar
   */
  deleteContact(phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    if (this.contacts[cleanPhone]) {
      delete this.contacts[cleanPhone];
      this.saveContacts();
      return true;
    }
    return false;
  }

  /**
   * Toggle status aktif/nonaktif AI untuk suatu nomor
   */
  toggleContactStatus(phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    if (!this.contacts[cleanPhone]) {
      this.contacts[cleanPhone] = {
        name: cleanPhone,
        category: 'default',
        enabled: true,
        notes: ''
      };
    } else {
      this.contacts[cleanPhone].enabled = !this.contacts[cleanPhone].enabled;
    }
    this.saveContacts();
    return this.contacts[cleanPhone].enabled;
  }

  getHistory(phone) {
    // Sinkronkan memory terbaru dari file jika ada update eksternal
    if (fs.existsSync(this.memoryFile)) {
      try {
        this.memory = JSON.parse(fs.readFileSync(this.memoryFile, 'utf-8'));
      } catch {}
    }
    const clean = (phone || '').replace(/\D/g, '');
    return this.memory[clean] || this.memory[phone] || [];
  }

  clearHistory(phone) {
    const clean = (phone || '').replace(/\D/g, '');
    let deleted = false;
    if (this.memory[clean]) {
      delete this.memory[clean];
      deleted = true;
    }
    if (this.memory[phone]) {
      delete this.memory[phone];
      deleted = true;
    }
    if (deleted) {
      this.saveMemory();
    }
    return deleted;
  }

  addMessage(phone, role, content, meta = null) {
    if (!this.memory[phone]) {
      this.memory[phone] = [];
    }

    const msgObj = {
      role,
      content,
      timestamp: new Date().toISOString()
    };

    if (meta && typeof meta === 'object') {
      msgObj.meta = meta;
    }

    this.memory[phone].push(msgObj);

    if (this.memory[phone].length > this.maxHistory * 2) {
      this.memory[phone] = this.memory[phone].slice(-this.maxHistory * 2);
    }

    this.saveMemory();
  }

  buildPromptMessages(senderJid, incomingText, injectedKnowledge = '', senderPushName = '') {
    const profile = this.getContactProfile(senderJid, senderPushName);
    const categoryKey = this.persona.categories[profile.category] ? profile.category : 'default';
    const catConfig = this.persona.categories[categoryKey] || {};
    const general = this.persona.general_persona || {};
    const availableStickers = this.getAvailableStickersList();

    const systemInstructions = [
      general.identity || 'Kamu adalah representasi digital diri saya (Another Me). Balas chat seperti gaya asli saya mengetik di WhatsApp.',
      '',
      '--- ATURAN UMUM PENGETIKAN ---',
      ...(general.core_typing_rules || []).map((r) => `- ${r}`),
      '',
      `--- KONTEKS LAWAN BICARA (METADATA SENDER) ---`,
      `- Nama Kontak Tersimpan: ${profile.name}`,
      profile.pushName ? `- Nama WhatsApp Pengirim (Push Name): ${profile.pushName}` : '',
      `- Nomor WhatsApp: ${profile.phone}`,
      `- Kategori Relasi: ${categoryKey}`,
      profile.notes ? `- Catatan Khusus Kontak: ${profile.notes}` : '',
      catConfig.tone ? `- Nada Bicara / Sikap: ${catConfig.tone}` : '',
      catConfig.guidelines ? `- Panduan Perilaku: ${catConfig.guidelines}` : '',
      catConfig.vocabulary && catConfig.vocabulary.length ? `- Kata-kata khas / Panggilan yang sering dipakai: ${catConfig.vocabulary.join(', ')}` : '',
      '',
      injectedKnowledge ? `--- BASIS PENGETAHUAN PRIBADI (KNOWLEDGE BASE) ---\nGunakan informasi faktual berikut jika relevan dengan pertanyaan lawan bicara:\n${injectedKnowledge}\n` : '',
      '--- KEMAMPUAN TOOLS OTONOM (AGENT HARNESS) ---',
      'Kamu memiliki akses ke beberapa tool penting:',
      '1. get_current_time: untuk tahu jam, tanggal, dan fase waktu (pagi/siang/sore/malam) secara akurat.',
      '2. get_weather: untuk cek cuaca, suhu, dan apakah sedang hujan di lokasi.',
      '3. web_search: gunakan tool ini jika lawan bicara menanyakan fakta luar, berita terkini, skor bola, jadwal rilis film/anime, kafe/tempat hits, atau informasi yang kamu belum tahu persis.',
      '4. send_sticker: untuk memilih dan mengirim stiker WhatsApp yang cocok dengan emosimu.',
      '5. query_knowledge: untuk memeriksa catatan pribadi atau agenda.',
      '',
      '--- KEBIASAAN PENGIRIMAN STIKER (PRIORITAS EKSPRESI) ---',
      'Sebagai "Another Me", kamu sangat ekspresif dan sering menggunakan stiker WhatsApp dalam chatting sehari-hari.',
      'SETIAP KALI membalas pesan, SELALU PERTIMBANGKAN mood, nada emosi, atau topik chat saat ini (apakah lucu, tertawa, manja, kangen, lelah, gemes, ngambek bercanda, atau menyindir santai).',
      availableStickers.length > 0
        ? `Stiker yang kamu miliki di koleksi:\n[ ${availableStickers.join(', ')} ]\nJika suasana percakapan cocok dengan salah satu stiker di atas, PANGGIL tool "send_sticker" dengan tag stiker tersebut bersama balasan teksmu. Jangan ragu mengirim stiker agar percakapan terasa hidup dan natural!`
        : 'Jika belum ada stiker di koleksi, cukup balas dengan teks.',
      '',
      '--- ATURAN PENGIRIMAN MULTI-CHAT (MULTI-BUBBLE) ---',
      'Orang Indonesia saat chatting di WhatsApp sering mengirim beberapa chat pendek berurutan sesuai alur pikiran mereka.',
      'Pikirkan: Apakah lebih natural jika dipecah menjadi beberapa chat terpisah? (Misal chat 1 sapaan/reaksi awal, chat 2 inti cerita/pertanyaan, chat 3 tanggapan tambahan, dsb).',
      'Jika kamu ingin mengirim LEBIH DARI SATU balon chat terpisah, pisahkan setiap balon chat dengan penanda garis tiga: "---".',
      'Contoh 1:',
      'Hay hay',
      '---',
      'ada apa?',
      'Contoh 2:',
      'wkwkwk kocak banget anjir',
      '---',
      'terus lu jadinya gimana sama dia?',
      '---',
      'ceritain dong penasaran gw',
      'Kamu BEBAS mengirim berapa pun jumlah balon chat yang menurutmu wajar dan natural sesuai emosi dan panjang obrolan, tanpa dibatasi jumlahnya.',
      'Jika hanya butuh 1 balon chat saja, cukup ketik 1 teks biasa tanpa tanda "---".',
      '',
      '--- PENTING ---',
      'Hanya hasilkan teks balasan persis apa yang akan saya ketik di WhatsApp. Jangan tambahkan penjelasan, jangan buat dialog dua orang, dan jangan gunakan prefiks seperti "Balasan:".'
    ].filter(Boolean).join('\n');

    const messages = [{ role: 'system', content: systemInstructions }];

    if (Array.isArray(catConfig.few_shots) && catConfig.few_shots.length > 0) {
      for (const shot of catConfig.few_shots) {
        if (shot.user && shot.reply) {
          messages.push({ role: 'user', content: shot.user });
          messages.push({ role: 'assistant', content: shot.reply });
        }
      }
    }

    const history = this.getHistory(profile.phone);
    for (const h of history) {
      messages.push({
        role: h.role,
        content: h.content
      });
    }

    messages.push({
      role: 'user',
      content: incomingText
    });

    return messages;
  }
}

module.exports = ContextManager;
