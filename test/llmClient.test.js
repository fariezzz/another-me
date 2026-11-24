const test = require('node:test');
const assert = require('node:assert/strict');
const LLMClient = require('../src/llmClient');

test('capitalizeFirstLetter preserves leading emoji and punctuation', () => {
  const llm = new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' });
  assert.equal(llm.capitalizeFirstLetter('pagi sayang'), 'Pagi sayang');
  assert.equal(llm.capitalizeFirstLetter('🥹 pagi sayang'), '🥹 Pagi sayang');
  assert.equal(llm.capitalizeFirstLetter('...iyaa bentar'), '...Iyaa bentar');
  assert.equal(llm.capitalizeFirstLetter('Sudah kapital'), 'Sudah kapital');
  assert.equal(llm.capitalizeFirstLetter(''), '');
});

test('splitIntoMessages enforces max 2 bubbles without dropping excess content', () => {
  const llm = new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' });
  const text = 'Halo beb\n---\nLagi ngapain?\n---\nJangan lupa makan ya';
  const capped = llm.splitIntoMessages(text, 2);
  assert.equal(capped.length, 2);
  assert.equal(capped[0], 'Halo beb');
  assert.equal(capped[1], 'Lagi ngapain?\nJangan lupa makan ya');

  // Manual send (uncapped) retains all 3 bubbles
  const uncapped = llm.splitIntoMessages(text);
  assert.equal(uncapped.length, 3);

  // Pure sticker marker collapses to empty array
  assert.deepEqual(llm.splitIntoMessages('[Mengirim Stiker: hehe]'), []);
});

test('cleanResponse strips thought blocks, self-correction, drafts, and sticker markers', () => {
  const llm = new LLMClient({ baseUrl: 'http://127.0.0.1:4000/v1beta/openai', model: 'gemma-4-26b-a4b-it' });
  const raw = '<thought>Analisa internal panjang</thought>\nDraft: Halo\nBalasan: "Lagi santai nih [Mengirim Stiker: ketawa] call:send_sticker(sticker_tag="ketawa")"';
  assert.equal(llm.cleanResponse(raw), 'Lagi santai nih');

  const malformed = 'Self-Correction: harusnya singkat</thought>Oke aman bro';
  assert.equal(llm.cleanResponse(malformed), 'Oke aman bro');
});

test('updateConfig validates protocol and clears apiKey when origin changes', () => {
  const llm = new LLMClient({
    baseUrl: 'https://api.example-one.com/v1',
    apiKey: 'secret-key-123',
    model: 'gemma4'
  });

  assert.throws(() => llm.updateConfig({ baseUrl: 'file:///etc/passwd' }), /http:\/\/ atau https:\/\//);
  assert.throws(() => llm.updateConfig({ baseUrl: 'not a url' }), /tidak valid/);

  // Changing host without passing apiKey clears the previous key (SEC-03)
  llm.updateConfig({ baseUrl: 'https://api.example-two.com/v1' });
  assert.equal(llm.apiKey, '');
  assert.equal(llm.baseUrl, 'https://api.example-two.com/v1');
});

test('checkHealth caches result within TTL and refreshes when forced', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: true, status: 200 };
  };

  try {
    const llm = new LLMClient({
      baseUrl: 'http://127.0.0.1:4000/v1beta/openai',
      model: 'gemma-4-26b-a4b-it',
      healthCacheTtlMs: 60000
    });
    const first = await llm.checkHealth();
    const second = await llm.checkHealth();
    const forced = await llm.checkHealth({ force: true });

    assert.equal(first.connected, true);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(forced.cached, false);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('runAgentLoop never sends raw tool JSON when maxIterations is reached (BUG-02)', async () => {
  const originalFetch = global.fetch;
  let fetchCount = 0;

  global.fetch = async (_url, init) => {
    fetchCount++;
    const body = JSON.parse(init.body);
    // While tools are still provided, keep requesting tool calls
    if (body.tools) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: `tc-${fetchCount}`,
                    type: 'function',
                    function: { name: 'get_current_time', arguments: '{}' }
                  }
                ]
              }
            }
          ]
        })
      };
    }

    // Finalizing call without tools returns clean human reply
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Sekarang udah sore nih' } }]
      })
    };
  };

  try {
    const llm = new LLMClient({
      baseUrl: 'http://127.0.0.1:4000/v1beta/openai',
      model: 'gemma-4-26b-a4b-it',
      retryDelaysMs: [10, 10]
    });
    llm.setToolRegistry({
      getToolDefinitions: () => [{ type: 'function', function: { name: 'get_current_time' } }],
      executeTool: async () => ({ success: true, jam: '17:45' })
    });

    const result = await llm.runAgentLoop([{ role: 'user', content: 'Jam berapa?' }], { maxIterations: 2 });
    assert.equal(result.replyText, 'Sekarang udah sore nih');
    assert.ok(!result.replyText.includes('"success"'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('runAgentLoop does not retry empty text when native send_sticker already queued (BUG-07)', async () => {
  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'stk-1',
                    type: 'function',
                    function: { name: 'send_sticker', arguments: '{"sticker_tag":"ketawa"}' }
                  }
                ]
              }
            }
          ]
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '<thought>cukup stiker aja</thought>' } }]
      })
    };
  };

  try {
    const llm = new LLMClient({
      baseUrl: 'http://127.0.0.1:4000/v1beta/openai',
      model: 'gemma-4-26b-a4b-it',
      retryDelaysMs: [10, 10]
    });
    llm.setToolRegistry({
      getToolDefinitions: () => [{ type: 'function', function: { name: 'send_sticker' } }],
      executeTool: async (_name, _args, ctx) => {
        ctx.actions.push({ type: 'send_sticker', filePath: '/fake/ketawa.webp', tag: 'ketawa' });
        return { success: true };
      }
    });

    const result = await llm.runAgentLoop([{ role: 'user', content: 'wkwk lucu' }]);
    assert.equal(calls, 2); // No extra 3rd empty-retry call!
    assert.equal(result.replyText, '');
    assert.equal(result.actions.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('describeImage retries transient 503 via postChatCompletion (BUG-07)', async () => {
  const originalFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls++;
    if (calls === 1) {
      return { ok: false, status: 503, text: async () => 'high demand', headers: new Headers() };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Kucing lucu sedang tersenyum' } }]
      })
    };
  };

  try {
    const llm = new LLMClient({
      baseUrl: 'http://127.0.0.1:4000/v1beta/openai',
      model: 'gemma-4-26b-a4b-it',
      retryDelaysMs: [10, 10]
    });
    const desc = await llm.describeImage(Buffer.from('RIFF1234WEBP'), 'image/webp');
    assert.equal(calls, 2);
    assert.equal(desc, 'Kucing lucu sedang tersenyum');
  } finally {
    global.fetch = originalFetch;
  }
});

test('answerSearchQuery strips thoughts, summarizes cleanly, and returns empty string on failure', async () => {
  const originalFetch = global.fetch;

  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '<thought>Cek berita terbaru</thought>\npresiden Republik Indonesia saat ini adalah Prabowo Subianto.'
            }
          }
        ]
      })
    });

    const llm = new LLMClient({
      baseUrl: 'http://127.0.0.1:4000/v1beta/openai',
      model: 'gemma-4-26b-a4b-it',
      retryDelaysMs: [10]
    });
    const answer = await llm.answerSearchQuery('Siapa presiden indonesia', [
      { source: 'Berita', title: 'Presiden Prabowo', snippet: 'Presiden Prabowo (24 Nov 2026).' }
    ]);
    assert.equal(answer, 'Presiden Republik Indonesia saat ini adalah Prabowo Subianto.');

    // Saat provider gagal -> kembalikan string kosong agar !cari fallback mulus tanpa throw
    global.fetch = async () => ({
      ok: false,
      status: 500,
      text: async () => 'server error',
      headers: new Headers()
    });
    const fallback = await llm.answerSearchQuery('Siapa presiden indonesia', []);
    assert.equal(fallback, '');
  } finally {
    global.fetch = originalFetch;
  }
});
