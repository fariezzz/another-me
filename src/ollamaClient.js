/**
 * Ollama AI Client Adapter
 * Mendukung:
 * 1. Ollama Cloud / OpenAI-compatible endpoint (https://ollama.com/v1/chat/completions)
 * 2. Ollama Native local API (http://localhost:11434/api/chat)
 */

class OllamaClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '');
    this.model = options.model || process.env.OLLAMA_MODEL || 'gemma4';
    this.apiKey = options.apiKey || process.env.OLLAMA_API_KEY || '';
    this.isOpenAiCompatible = this.baseUrl.includes('/v1') || this.baseUrl.includes('ollama.com');
  }

  /**
   * Mengirim request chat completion
   * @param {Array<{role: string, content: string}>} messages
   * @param {Object} options
   * @returns {Promise<string>}
   */
  async chat(messages, options = {}) {
    if (this.isOpenAiCompatible) {
      return this.chatOpenAI(messages, options);
    }
    return this.chatNative(messages, options);
  }

  /**
   * Chat menggunakan format OpenAI-compatible (/chat/completions)
   */
  async chatOpenAI(messages, options = {}) {
    const url = `${this.baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const payload = {
      model: this.model,
      messages: messages,
      temperature: options.temperature ?? 0.7,
      top_p: options.top_p ?? 0.9,
      max_tokens: options.num_predict ?? 250
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama Cloud API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Respon OpenAI-compatible tidak memiliki format choices[0].message.content');
      }

      return this.cleanResponse(content);
    } catch (err) {
      console.error(`[OllamaClient Error] Gagal memanggil ${url} [model: ${this.model}]:`, err.message);
      throw err;
    }
  }

  /**
   * Chat menggunakan format Native Ollama (/api/chat)
   */
  async chatNative(messages, options = {}) {
    const url = `${this.baseUrl}/api/chat`;
    const payload = {
      model: this.model,
      messages: messages,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.7,
        top_p: options.top_p ?? 0.9,
        num_predict: options.num_predict ?? 250
      }
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama Native API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      if (!data.message || typeof data.message.content !== 'string') {
        throw new Error('Respon Ollama tidak memiliki format message.content yang valid');
      }

      return this.cleanResponse(data.message.content);
    } catch (err) {
      console.error(`[OllamaClient Error] Gagal memanggil ${url} [model: ${this.model}]:`, err.message);
      throw err;
    }
  }

  /**
   * Cek koneksi endpoint
   * @returns {Promise<{connected: boolean, message?: string}>}
   */
  async checkHealth() {
    try {
      const endpoint = this.isOpenAiCompatible ? `${this.baseUrl}/models` : `${this.baseUrl}/api/tags`;
      const headers = {};
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const response = await fetch(endpoint, { method: 'GET', headers });
      if (!response.ok) {
        return { connected: false, message: `Status code ${response.status}` };
      }
      return { connected: true };
    } catch (err) {
      return { connected: false, message: err.message };
    }
  }

  /**
   * Membersihkan teks jawaban dari format artifisial
   * @param {string} text
   * @returns {string}
   */
  cleanResponse(text) {
    if (!text) return '';
    let cleaned = text.trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1).trim();
    }
    cleaned = cleaned.replace(/^(Balasan|Aku|Saya|Me|Response):\s*/i, '');
    return cleaned;
  }
}

module.exports = OllamaClient;
