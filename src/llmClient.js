/**
 * Universal LLM Client & Autonomous Agent Harness
 * Mengikuti spesifikasi OpenAI-compatible API standar dengan Function Calling.
 *
 * Fitur:
 * - Function Calling / Tools loop (ReAct step-by-step resolution)
 * - Eksekusi tools otomatis (waktu, cuaca, stiker, knowledge)
 * - Fallback cerdas jika model tidak mendukung native tool calls
 */

class LLMClient {
  constructor(options = {}) {
    this.updateConfig({
      baseUrl: options.baseUrl || process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1',
      apiKey: options.apiKey || process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || '',
      model: options.model || process.env.LLM_MODEL || process.env.OLLAMA_MODEL || 'gemma4',
      visionModel: options.visionModel || process.env.VISION_MODEL || ''
    });
    this.toolRegistry = options.toolRegistry || null;
  }

  setToolRegistry(registry) {
    this.toolRegistry = registry;
  }

  updateConfig({ baseUrl, apiKey, model, visionModel }) {
    if (baseUrl !== undefined) {
      let url = (baseUrl || '').trim().replace(/\/+$/, '');
      if (url && !url.endsWith('/v1') && !url.includes('/v1/') && !url.endsWith('/openai') && !url.includes('/v1beta/openai')) {
        if (!url.endsWith('/api')) {
          url = `${url}/v1`;
        }
      }
      this.baseUrl = url;
    }
    if (apiKey !== undefined) {
      this.apiKey = (apiKey || '').trim();
    }
    if (model !== undefined) {
      this.model = (model || '').trim();
    }
    if (visionModel !== undefined) {
      this.visionModel = (visionModel || '').trim();
    }
  }

  /**
   * Satu panggilan chat completions dengan retry untuk error sementara
   * (2026-11-03): Google AI Studio untuk Gemma terbukti flaky — payload
   * yang sama kadang 200, kadang 500 "Internal error encountered".
   * Tanpa retry, satu 500 membuat pesan lawan bicara hilang tanpa
   * balasan (kasus 13:23 WIB, 2026-11-03). Retry hanya untuk status
   * sementara (429/500/502/503/504) dan gagal jaringan, maks 3 percobaan
   * total dengan jeda 2 dtk lalu 5 dtk. Error 400 dengan tools tetap
   * memakai fallback tanpa tools seperti sebelumnya; error lain
   * langsung dilempar tanpa retry.
   */
  async postChatCompletion(endpoint, headers, payload, allowToolFallback = true) {
    const transientStatuses = [429, 500, 502, 503, 504];
    const retryDelaysMs = [2000, 5000];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastError = null;

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });
      } catch (netErr) {
        lastError = netErr;
        if (attempt < retryDelaysMs.length) {
          console.warn(`[AgentHarness] Gagal jaringan, retry ${attempt + 1}/${retryDelaysMs.length} setelah ${retryDelaysMs[attempt]}ms: ${netErr.message}`);
          await sleep(retryDelaysMs[attempt]);
          continue;
        }
        throw netErr;
      }

      if (response.ok) return await response.json();

      const errorText = await response.text();

      // Jika provider menolak parameter `tools`, coba fallback tanpa tools
      if (response.status === 400 && payload.tools && allowToolFallback) {
        console.warn(`[AgentHarness] Provider menolak tools, beralih ke mode teks murni: ${errorText}`);
        const noToolsPayload = { ...payload };
        delete noToolsPayload.tools;
        delete noToolsPayload.tool_choice;
        return this.postChatCompletion(endpoint, headers, noToolsPayload, false);
      }

      lastError = new Error(`LLM API Provider Error (${response.status}): ${errorText}`);
      if (transientStatuses.includes(response.status) && attempt < retryDelaysMs.length) {
        console.warn(`[AgentHarness] Provider error ${response.status}, retry ${attempt + 1}/${retryDelaysMs.length} setelah ${retryDelaysMs[attempt]}ms.`);
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
      throw lastError;
    }
    throw lastError;
  }

  /**
   * Menjalankan Agent Loop (Autonomous Tool Calling Loop)
   * Mengulang siklus LLM -> Tool Call -> Tool Result -> LLM hingga menghasilkan balasan final.
   *
   * @param {Array<{role: string, content: string}>} initialMessages
   * @param {Object} options
   * @returns {Promise<{replyText: string, actions: Array<any>, toolCallsLog: Array<any>}>}
   */
  async runAgentLoop(initialMessages, options = {}) {
    const messages = [...initialMessages];
    const actions = [];
    const toolCallsLog = [];
    const maxIterations = options.maxIterations || 5;
    // Jika balasan bersihnya kosong (Gemma sempat menghabiskan token
    // hanya untuk <thought>), coba sekali lagi dengan instruksi singkat
    // sebelum menyerah, supaya kegagalan tidak diam-diam.
    let emptyRetries = 0;

    // Ambil tool definitions jika registry tersedia
    const tools = this.toolRegistry ? this.toolRegistry.getToolDefinitions() : null;

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration++;

      // Siapkan payload chat completions
      const endpoint = `${this.baseUrl}/chat/completions`;
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const payload = {
        model: this.model,
        messages: messages,
        temperature: options.temperature ?? 0.7,
        top_p: options.top_p ?? 0.9,
        // 2048, bukan 700: blok <thought> Gemma bisa sangat panjang dan
        // memotong jawaban final kalau jatah token terlalu kecil
        // (finish_reason: length, lalu cleanResponse menyisakan string kosong).
        max_tokens: options.max_tokens ?? 2048
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = 'auto';
      }

      let responseData;
      try {
        responseData = await this.postChatCompletion(endpoint, headers, payload);
      } catch (err) {
        console.error(`[AgentHarness Error] Gagal iterasi ke-${iteration}:`, err.message);
        throw err;
      }

      const choice = responseData.choices?.[0];
      if (!choice || !choice.message) {
        throw new Error('Respon LLM tidak memiliki format choice.message yang valid.');
      }

      const assistantMsg = choice.message;
      const toolCalls = assistantMsg.tool_calls;

      // KASUS 1: Model ingin memanggil tools
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        // Tambahkan respon assistant ke messages
        messages.push(assistantMsg);

        for (const tc of toolCalls) {
          const toolName = tc.function?.name;
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(tc.function?.arguments || '{}');
          } catch {
            parsedArgs = {};
          }

          const callLog = {
            id: tc.id || Date.now().toString(),
            name: toolName,
            args: parsedArgs,
            time: new Date().toLocaleTimeString('id-ID', { hour12: false })
          };

          // Eksekusi tool via Tool Registry
          let toolResult = null;
          try {
            toolResult = await this.toolRegistry.executeTool(toolName, parsedArgs, {
              actions,
              category: options.category || 'default',
              senderPhone: options.senderPhone || ''
            });
            callLog.result = toolResult;
          } catch (execErr) {
            toolResult = { error: execErr.message };
            callLog.error = execErr.message;
          }

          toolCallsLog.push(callLog);

          // Masukkan tool result kembali ke daftar messages dengan role: 'tool'
          messages.push({
            role: 'tool',
            tool_call_id: tc.id || callLog.id,
            name: toolName,
            content: JSON.stringify(toolResult)
          });
        }

        // Lanjutkan iterasi loop berikutnya agar LLM membaca hasil tool dan menyusun jawaban
        continue;
      }

      // KASUS 2: Model selesai dan memberikan teks jawaban akhir
      const rawContent = assistantMsg.content || '';
      // Fallback pseudo-call (2026-11-02): Gemma kadang tidak memakai
      // tool call bawaan, melainkan menulis "call:send_sticker(...)"
      // sebagai teks. Tanpa ini, teks itu lolos jadi balon chat dan
      // stikernya tidak pernah terkirim. Tangkap dulu, eksekusi sebagai
      // tool sungguhan, lalu bersihkan sisanya dari teks balasan.
      const pseudo = await this.extractPseudoStickerCalls(rawContent, {
        actions,
        category: options.category || 'default',
        senderPhone: options.senderPhone || ''
      });
      for (const call of pseudo.calls) {
        toolCallsLog.push({
          id: `pseudo-${Date.now()}-${toolCallsLog.length}`,
          name: 'send_sticker',
          args: { sticker_tag: call.tag },
          result: call.result,
          pseudoCall: true,
          time: new Date().toLocaleTimeString('id-ID', { hour12: false })
        });
      }
      const replyText = this.cleanResponse(pseudo.text);

      // Stiker saja tanpa teks adalah balasan yang sah (bukan kegagalan
      // thought-only), jadi jangan buang waktu me-retry di kasus ini.
      if (!replyText && pseudo.calls.length > 0) {
        return { replyText: '', actions, toolCallsLog };
      }

      // Balasan kosong setelah thought dibersihkan = jawaban tidak pernah
      // dibuat (token habis untuk penalaran). Coba sekali lagi dengan
      // instruksi singkat, jangan diam-diam mengembalikan string kosong.
      if (!replyText && emptyRetries < 1) {
        emptyRetries++;
        console.warn('[AgentHarness] Balasan bersih kosong (kemungkinan thought-only), mencoba ulang sekali dengan instruksi singkat.');
        messages.push({
          role: 'user',
          content: 'Balasanmu kosong. Kirim HANYA balasan final yang singkat untuk lawan bicara, tanpa penalaran internal, tanpa tag <thought> atau <think>.'
        });
        continue;
      }

      return {
        replyText,
        actions,
        toolCallsLog
      };
    }

    // Jika melebihi batas iterasi, ambil pesan assistant terakhir
    const lastMsg = messages[messages.length - 1];
    return {
      replyText: this.cleanResponse(lastMsg?.content || ''),
      actions,
      toolCallsLog
    };
  }

  /**
   * Menangkap pemanggilan stiker yang ditulis model sebagai teks, bukan
   * sebagai tool call bawaan, mis.:
   *   call:send_sticker(sticker_tag="hehe")
   *   send_sticker(sticker_tag='hehe')
   *   send_sticker("hehe")
   * Setiap tag yang tertangkap dieksekusi lewat ToolRegistry (menambah
   * action send_sticker yang nantinya dikirim Baileys) dan dihapus dari
   * teks, sehingga tidak ada lagi yang bocor jadi balon chat.
   * Mengembalikan teks sisa dan daftar pemanggilan yang dieksekusi.
   */
  async extractPseudoStickerCalls(rawText, context = {}) {
    const empty = { text: rawText || '', calls: [] };
    if (!this.toolRegistry || !rawText) return empty;
    const pattern = /(?:call\s*:\s*)?send_sticker\s*\(\s*(?:sticker_tag\s*=\s*)?["']?([A-Za-z0-9_-]+)["']?\s*\)/gi;
    const tags = [];
    let match;
    while ((match = pattern.exec(rawText)) !== null) {
      if (match[1] && !tags.includes(match[1].toLowerCase())) tags.push(match[1].toLowerCase());
    }
    if (tags.length === 0) return empty;
    const calls = [];
    for (const tag of tags) {
      try {
        const result = await this.toolRegistry.executeTool('send_sticker', { sticker_tag: tag }, context);
        calls.push({ tag, result });
      } catch (err) {
        calls.push({ tag, result: { error: err.message } });
      }
    }
    return { text: rawText.replace(pattern, ''), calls };
  }

  /**
   * Menginterpretasi stiker / gambar menggunakan Vision API
   * @param {Buffer} imageBuffer
   * @param {string} mimeType
   * @returns {Promise<string>}
   */
  async describeImage(imageBuffer, mimeType = 'image/webp') {
    const base64Data = imageBuffer.toString('base64');
    const endpoint = `${this.baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const promptText = 'Ini adalah stiker WhatsApp yang baru saja dikirim oleh lawan bicara. Deskripsikan ekspresi, karakter, tulisan/teks (jika ada), dan makna emosi dari stiker ini dalam 1-2 kalimat ringkas dan jelas dalam Bahasa Indonesia.';
    const targetModel = this.visionModel || this.model;

    const payload = {
      model: targetModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Data}`
              }
            }
          ]
        }
      ],
      max_tokens: 150,
      temperature: 0.3
    };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[Vision Warning] Model tidak mendukung input gambar/stiker (${response.status}): ${errText}`);
        return '';
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      return (content || '').trim();
    } catch (err) {
      console.warn('[Vision Error] Gagal menganalisis stiker:', err.message);
      return '';
    }
  }

  /**
   * Panggilan langsung sederhana tanpa agent loop
   */
  async chat(messages, options = {}) {
    const result = await this.runAgentLoop(messages, options);
    return result.replyText;
  }

  /**
   * Cek kesehatan dan koneksi API endpoint
   */
  async checkHealth() {
    if (!this.baseUrl) return { connected: false, message: 'Base URL kosong' };
    try {
      const endpoint = `${this.baseUrl}/models`;
      const headers = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const response = await fetch(endpoint, { method: 'GET', headers });
      if (!response.ok) return { connected: false, message: `HTTP status ${response.status}` };
      return { connected: true };
    } catch (err) {
      return { connected: false, message: err.message };
    }
  }

  /**
   * Memisahkan teks respon menjadi beberapa pesan (multi-bubble) jika dipisahkan dengan '---'
   * @param {string} text
   * @returns {string[]}
   */
  /**
   * Mengkapitalkan huruf pertama sebuah balon chat (2026-11-02:
   * aturan mengetik global, berlaku untuk semua lawan bicara).
   * Huruf pertama yang ditemukan yang diubah — emoji atau tanda baca
   * di depan dibiarkan, mis. "🥹 pagi" jadi "🥹 Pagi".
   */
  capitalizeFirstLetter(text) {
    if (!text) return text;
    return text.replace(/[\p{L}]/u, (ch) => ch.toUpperCase());
  }

  /**
   * Memisahkan teks menjadi balon-balon chat. maxBubbles membatasi
   * jumlah balon: kelebihan bagian TIDAK dibuang, melainkan digabung
   * ke balon terakhir dengan baris baru, supaya isi tidak hilang.
   * Balasan bot memakai max 2 (2026-11-02); kirim manual pemilik
   * memakai default tanpa batas.
   */
  splitIntoMessages(text, maxBubbles = Infinity) {
    if (!text) return [];
    const parts = text
      .split(/\n\s*---\s*\n|\n---\n|^---\n|\n---$/)
      .map(p => this.cleanResponse(p))
      .filter(p => p.length > 0);

    // Kalau semua bagian habis dibersihkan (mis. balasan yang isinya
    // hanya penanda stiker), kembalikan list kosong, bukan [""], supaya
    // pemanggil tidak mengirim balon kosong dan bisa mencatatnya.
    let result;
    if (parts.length > 0) result = parts;
    else result = this.cleanResponse(text) ? [this.cleanResponse(text)] : [];

    const cap = Math.max(1, Math.floor(maxBubbles) || Infinity);
    if (result.length > cap) {
      result = [...result.slice(0, cap - 1), result.slice(cap - 1).join('\n')];
    }
    return result;
  }

  cleanResponse(text) {
    if (!text) return '';
    let cleaned = text.trim();
    // Buang blok penalaran internal model, dalam bentuk apa pun, SEBELUM
    // teks dipecah jadi multi-bubble, supaya blok yang terpotong "---"
    // tidak lolos sebagai balon chat terpisah.
    // 1. Blok <thought>...</thought> dan <think>...</think> yang utuh.
    cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // 2. Blok malformed: diawali "Self-Correction:" tanpa tag pembuka,
    //    diakhiri </thought> (seperti yang sempat bocor ke WhatsApp).
    cleaned = cleaned.replace(/Self-Correction:[\s\S]*?<\/thought>/gi, '');
    // 3. Sisa tag dan baris "Draft:" yang tertinggal.
    cleaned = cleaned.replace(/<\/?thought>/gi, '');
    cleaned = cleaned.replace(/<\/?think>/gi, '');
    // Penalaran bebas tanpa tag (mis. "I'll call the sticker tool...") yang
    // tertinggal setelah balasan final: buang dari frasa itu sampai akhir.
    cleaned = cleaned.replace(/(And )?I('ll| will) call the (sticker )?tool[\s\S]*$/i, '');
    cleaned = cleaned.replace(/Wait, I can'?t call the tool[\s\S]*$/i, '');
    cleaned = cleaned.replace(/Let'?s try:\s*$/i, '');
    cleaned = cleaned.replace(/^Draft:.*$/gim, '');
    // Jaring pengaman terakhir: pemanggilan stiker sebagai teks yang
    // lolos dari jalur mana pun (mis. fallback batas iterasi) harus
    // dibuang, bukan dikirim sebagai balon chat.
    cleaned = cleaned.replace(/(?:call\s*:\s*)?send_sticker\s*\([^)]*\)/gi, '');
    // Penanda "[Mengirim Stiker: ...]" juga tidak boleh terkirim sebagai
    // teks: stiker asli dikirim terpisah lewat tool, dan penanda ini
    // hanya catatan internal. Model sempat meniru penanda ini dari
    // riwayat (17:32-17:38, 2026-11-02), jadi buang semua variannya.
    cleaned = cleaned.replace(/\[Mengirim Sti[ck]\w*[^\]]*\]/gi, '');
    cleaned = cleaned.trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    cleaned = cleaned.replace(/^(Balasan|Aku|Saya|Me|Response|Bot):\s*/i, '');
    // Jika setelah dibersihkan hanya tersisa penalaran, jangan kirim apa-apa.
    if (/^Self-Correction:/i.test(cleaned)) return '';
    return cleaned;
  }
}

module.exports = LLMClient;
