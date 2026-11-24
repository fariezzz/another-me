/**
 * Universal LLM Client & Autonomous Agent Harness
 * Mengikuti spesifikasi OpenAI-compatible API standar dengan Function Calling.
 *
 * Fitur:
 * - Function Calling / Tools loop (ReAct step-by-step resolution)
 * - Eksekusi tools otomatis (waktu, cuaca, stiker, knowledge, web search)
 * - Fallback cerdas jika model tidak mendukung native tool calls
 * - Retry untuk galat sementara (429/500/502/503/504) dengan dukungan Retry-After
 * - Batas waktu (AbortSignal.timeout) dan cache health check
 */

class LLMClient {
  constructor(options = {}) {
    this.baseUrl = '';
    this.apiKey = '';
    this.model = '';
    this.visionModel = '';
    this.healthCache = null;
    this.healthCacheTtlMs = options.healthCacheTtlMs ?? 60000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 45000;
    this.visionTimeoutMs = options.visionTimeoutMs ?? 15000;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 5000;
    this.retryDelaysMs = options.retryDelaysMs || [2000, 5000];

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

  /**
   * Memvalidasi dan menormalkan URL dasar endpoint LLM.
   * Hanya mengizinkan protokol http: dan https:.
   * @param {string} rawUrl
   * @returns {string}
   */
  normalizeAndValidateBaseUrl(rawUrl) {
    let url = String(rawUrl || '').trim().replace(/\/+$/, '');
    if (!url) return '';

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Base URL LLM tidak valid.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Base URL LLM harus menggunakan protokol http:// atau https://.');
    }

    if (
      !url.endsWith('/v1') &&
      !url.includes('/v1/') &&
      !url.endsWith('/openai') &&
      !url.includes('/v1beta/openai') &&
      !url.endsWith('/api')
    ) {
      url = `${url}/v1`;
    }

    return url;
  }

  getOriginSafe(urlStr) {
    if (!urlStr) return '';
    try {
      return new URL(urlStr).origin;
    } catch {
      return '';
    }
  }

  updateConfig({ baseUrl, apiKey, model, visionModel }) {
    const previousOrigin = this.getOriginSafe(this.baseUrl);
    let originChanged = false;

    if (baseUrl !== undefined) {
      const normalized = this.normalizeAndValidateBaseUrl(baseUrl);
      const nextOrigin = this.getOriginSafe(normalized);
      originChanged = Boolean(previousOrigin && nextOrigin && previousOrigin !== nextOrigin);
      this.baseUrl = normalized;
    }

    if (apiKey !== undefined) {
      this.apiKey = String(apiKey || '').trim();
    } else if (originChanged) {
      // Mencegah kebocoran kunci API lama ke host baru saat baseUrl diganti
      this.apiKey = '';
    }

    if (model !== undefined) {
      this.model = String(model || '').trim();
    }
    if (visionModel !== undefined) {
      this.visionModel = String(visionModel || '').trim();
    }

    // Batalkan cache kesehatan agar panggilan berikutnya memverifikasi konfigurasi baru
    this.healthCache = null;
  }

  /**
   * Menghitung jeda retry dengan menghormati header Retry-After pada HTTP 429.
   * @param {Response} response
   * @param {number} defaultDelayMs
   * @returns {number}
   */
  computeRetryDelayMs(response, defaultDelayMs) {
    if (!response || response.status !== 429) return defaultDelayMs;
    const retryAfter = response.headers?.get?.('retry-after');
    if (!retryAfter) return defaultDelayMs;

    const maxDelayMs = 30000;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), defaultDelayMs), maxDelayMs);
    }

    const retryDateMs = Date.parse(retryAfter);
    if (Number.isFinite(retryDateMs)) {
      const diff = retryDateMs - Date.now();
      if (diff > 0) {
        return Math.min(Math.max(diff, defaultDelayMs), maxDelayMs);
      }
    }

    return defaultDelayMs;
  }

  /**
   * Satu panggilan chat completions dengan retry untuk error sementara
   * (429/500/502/503/504) dan gagal jaringan, maks 3 percobaan total
   * dengan jeda default 2 detik lalu 5 detik serta batas waktu AbortSignal.timeout.
   */
  async postChatCompletion(endpoint, headers, payload, allowToolFallback = true, timeoutMs = this.requestTimeoutMs) {
    const transientStatuses = [429, 500, 502, 503, 504];
    const retryDelaysMs = this.retryDelaysMs;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastError = null;

    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (netErr) {
        lastError = netErr;
        if (attempt < retryDelaysMs.length) {
          console.warn(`[AgentHarness] Gagal jaringan/timeout, retry ${attempt + 1}/${retryDelaysMs.length} setelah ${retryDelaysMs[attempt]}ms: ${netErr.message}`);
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
        return this.postChatCompletion(endpoint, headers, noToolsPayload, false, timeoutMs);
      }

      lastError = new Error(`LLM API Provider Error (${response.status}): ${errorText}`);
      if (transientStatuses.includes(response.status) && attempt < retryDelaysMs.length) {
        const waitMs = this.computeRetryDelayMs(response, retryDelaysMs[attempt]);
        console.warn(`[AgentHarness] Provider error ${response.status}, retry ${attempt + 1}/${retryDelaysMs.length} setelah ${waitMs}ms.`);
        await sleep(waitMs);
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
    let emptyRetries = 0;

    const tools = this.toolRegistry ? this.toolRegistry.getToolDefinitions() : null;
    const endpoint = `${this.baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration++;

      const payload = {
        model: this.model,
        messages: messages,
        temperature: options.temperature ?? 0.7,
        top_p: options.top_p ?? 0.9,
        // 2048: blok <thought> Gemma bisa panjang dan memotong jawaban final pada limit lebih kecil.
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

          messages.push({
            role: 'tool',
            tool_call_id: tc.id || callLog.id,
            name: toolName,
            content: JSON.stringify(toolResult)
          });
        }

        continue;
      }

      // KASUS 2: Model selesai dan memberikan teks jawaban akhir
      const rawContent = assistantMsg.content || '';
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

      // Stiker saja (baik lewat pseudo-call maupun native tool call) adalah balasan sah
      const hasStickerAction =
        pseudo.calls.length > 0 || actions.some((a) => a.type === 'send_sticker');
      if (!replyText && hasStickerAction) {
        return { replyText: '', actions, toolCallsLog };
      }

      // Balasan kosong setelah thought dibersihkan = jawaban tidak pernah dibuat
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

    // Jika melebihi batas iterasi saat pesan terakhir adalah hasil tool (role: 'tool'),
    // lakukan satu panggilan penutup TANPA tools agar model menyusun kalimat final
    // dan tidak pernah mengirim JSON mentah hasil tool ke WhatsApp.
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'tool') {
      try {
        const finalMessages = [
          ...messages,
          {
            role: 'user',
            content: 'Batas pemanggilan tool tercapai. Gunakan hasil tool di atas untuk langsung menulis balasan WhatsApp final yang singkat dan natural tanpa memanggil tool lagi.'
          }
        ];
        const finalPayload = {
          model: this.model,
          messages: finalMessages,
          temperature: options.temperature ?? 0.7,
          top_p: options.top_p ?? 0.9,
          max_tokens: options.max_tokens ?? 2048
        };
        const finalData = await this.postChatCompletion(endpoint, headers, finalPayload, false);
        const finalRaw = finalData?.choices?.[0]?.message?.content || '';
        const pseudo = await this.extractPseudoStickerCalls(finalRaw, {
          actions,
          category: options.category || 'default',
          senderPhone: options.senderPhone || ''
        });
        const finalReply = this.cleanResponse(pseudo.text);
        if (finalReply || actions.some((a) => a.type === 'send_sticker')) {
          return { replyText: finalReply, actions, toolCallsLog };
        }
      } catch (finalErr) {
        console.warn('[AgentHarness] Panggilan penutup pasca batas iterasi gagal:', finalErr.message);
      }
    }

    // Fallback aman: cari mundur pesan assistant terakhir yang memiliki teks non-kosong;
    // jangan pernah mengembalikan konten dari role: 'tool'.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
        const cleaned = this.cleanResponse(m.content);
        if (cleaned) {
          return { replyText: cleaned, actions, toolCallsLog };
        }
      }
    }

    return {
      replyText: '',
      actions,
      toolCallsLog
    };
  }

  /**
   * Menangkap pemanggilan stiker yang ditulis model sebagai teks, bukan sebagai tool call bawaan.
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
   * Menginterpretasi stiker / gambar menggunakan Vision API dengan retry dan timeout.
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
      const data = await this.postChatCompletion(endpoint, headers, payload, false, this.visionTimeoutMs);
      const content = data.choices?.[0]?.message?.content;
      return this.cleanResponse(content || '');
    } catch (err) {
      console.warn('[Vision Error] Gagal menganalisis stiker:', err.message);
      return '';
    }
  }

  /**
   * Panggilan langsung sederhana
   */
  async chat(messages, options = {}) {
    const result = await this.runAgentLoop(messages, options);
    return result.replyText;
  }

  /**
   * Cek kesehatan dan koneksi API endpoint dengan cache 60 detik dan timeout 5 detik.
   * @param {{ force?: boolean }} [options]
   */
  async checkHealth(options = {}) {
    if (!this.baseUrl) return { connected: false, message: 'Base URL kosong' };

    const now = Date.now();
    if (
      !options.force &&
      this.healthCache &&
      now - this.healthCache.checkedAt < this.healthCacheTtlMs
    ) {
      return { ...this.healthCache.result, cached: true };
    }

    let result;
    try {
      const endpoint = `${this.baseUrl}/models`;
      const headers = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const response = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.healthTimeoutMs)
      });
      if (!response.ok) {
        result = { connected: false, message: `HTTP status ${response.status}` };
      } else {
        result = { connected: true };
      }
    } catch (err) {
      result = { connected: false, message: err.message };
    }

    this.healthCache = { checkedAt: now, result };
    return { ...result, cached: false };
  }

  /**
   * Mengkapitalkan huruf pertama sebuah balon chat (aturan mengetik global).
   * Emoji atau tanda baca di depan dibiarkan, mis. "🥹 pagi" jadi "🥹 Pagi".
   */
  capitalizeFirstLetter(text) {
    if (!text) return text;
    return text.replace(/[\p{L}]/u, (ch) => ch.toUpperCase());
  }

  /**
   * Memisahkan teks menjadi balon-balon chat. maxBubbles membatasi jumlah balon:
   * kelebihan bagian TIDAK dibuang, melainkan digabung ke balon terakhir dengan baris baru.
   */
  splitIntoMessages(text, maxBubbles = Infinity) {
    if (!text) return [];
    const parts = text
      .split(/\n\s*---\s*\n|\n---\n|^---\n|\n---$/)
      .map((p) => this.cleanResponse(p))
      .filter((p) => p.length > 0);

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
    cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    cleaned = cleaned.replace(/Self-Correction:[\s\S]*?<\/thought>/gi, '');
    cleaned = cleaned.replace(/<\/?thought>/gi, '');
    cleaned = cleaned.replace(/<\/?think>/gi, '');
    cleaned = cleaned.replace(/(And )?I('ll| will) call the (sticker )?tool[\s\S]*$/i, '');
    cleaned = cleaned.replace(/Wait, I can'?t call the tool[\s\S]*$/i, '');
    cleaned = cleaned.replace(/Let'?s try:\s*$/i, '');
    cleaned = cleaned.replace(/^Draft:.*$/gim, '');
    cleaned = cleaned.replace(/(?:call\s*:\s*)?send_sticker\s*\([^)]*\)/gi, '');
    cleaned = cleaned.replace(/\[Mengirim Sti[ck]\w*[^\]]*\]/gi, '');
    cleaned = cleaned.trim();
    cleaned = cleaned.replace(/^(Balasan|Aku|Saya|Me|Response|Bot):\s*/i, '').trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    if (/^Self-Correction:/i.test(cleaned)) return '';
    return cleaned;
  }
}

module.exports = LLMClient;
