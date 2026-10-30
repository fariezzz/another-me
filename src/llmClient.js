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
      if (url && !url.endsWith('/v1') && !url.includes('/v1/')) {
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
        max_tokens: options.max_tokens ?? 700
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = 'auto';
      }

      let responseData;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errorText = await response.text();
          // Jika provider menolak parameter `tools`, coba fallback tanpa tools
          if (response.status === 400 && payload.tools) {
            console.warn(`[AgentHarness] Provider menolak tools, beralih ke mode teks murni: ${errorText}`);
            delete payload.tools;
            delete payload.tool_choice;
            const fallbackRes = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
            if (!fallbackRes.ok) throw new Error(await fallbackRes.text());
            responseData = await fallbackRes.json();
          } else {
            throw new Error(`LLM API Provider Error (${response.status}): ${errorText}`);
          }
        } else {
          responseData = await response.json();
        }
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
      const replyText = this.cleanResponse(rawContent);

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
  splitIntoMessages(text) {
    if (!text) return [];
    const parts = text
      .split(/\n\s*---\s*\n|\n---\n|^---\n|\n---$/)
      .map(p => this.cleanResponse(p))
      .filter(p => p.length > 0);

    return parts.length > 0 ? parts : [this.cleanResponse(text)];
  }

  cleanResponse(text) {
    if (!text) return '';
    let cleaned = text.trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    cleaned = cleaned.replace(/^(Balasan|Aku|Saya|Me|Response|Bot):\s*/i, '');
    return cleaned;
  }
}

module.exports = LLMClient;
