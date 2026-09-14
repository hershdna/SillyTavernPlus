const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(api = 'openai', streaming = true) {
    const calls = []; const progress = [];
    const core = {
        main_api: api, is_send_press: false, amount_gen: 300, max_context: 8192,
        isStreamingEnabled: () => streaming,
        createRawPrompt: prompt => api === 'openai' ? [{ role:'user', content:prompt }] : prompt,
        event_types: { CHAT_COMPLETION_PROMPT_READY:'prompt', CHAT_COMPLETION_SETTINGS_READY:'settings', GENERATE_AFTER_COMBINE_PROMPTS:'text-prompt' },
        eventSource: { emit: async (...args) => calls.push(args) },
        getRequestHeaders: () => ({}),
        generateRawData: async () => ({ text:'Summary', reasoning:'Non-streamed reasoning' }),
        extractMessageFromData: data => data.text,
    };
    const streamFactory = async () => async function* () {
        yield {text:'<think>Test reasoning', state:{}};
        yield {text:'<think>Test reasoning</think>Summary', state:{}};
    };
    const native = {
        '/script.js': core,
        '/scripts/reasoning.js': { extractReasoningFromData: data => data.reasoning },
        '/scripts/power-user.js': { power_user:{reasoning:{auto_parse:true,prefix:'<think>',suffix:'</think>'}} },
        '/scripts/openai.js': {
            oai_settings: {chat_completion_source:'test', stream_openai:true, n:4},
            getChatCompletionModel: () => 'test-model',
            createGenerationParameters: async (settings, model, type, messages) => {
                calls.push(['build', type, messages]);
                return {generate_data:{stream:false, n:1}};
            },
            tryParseStreamingError: () => {},
            getStreamingReply: (data, state) => { state.reasoning += data.reasoning || ''; return data.text || ''; },
        },
        '/scripts/sse-stream.js': { getEventSourceStream: () => ({}) },
        '/scripts/textgen-settings.js': {
            getTextGenGenerationData: async (...args) => {calls.push(['text-build', ...args]); return {};},
            generateTextGenWithStreaming: streamFactory,
        },
    };
    let cancelled = false;
    const events = [{data:JSON.stringify({reasoning:'Live thought'})}, {data:JSON.stringify({text:'Summary'})}, {data:'[DONE]'}];
    const sandbox = vm.createContext({ console, Date, AbortController,
        importNative: async name => { if (!native[name]) throw Error(name); return native[name]; },
        fetch: async (url, options) => {
            calls.push(['fetch',url, JSON.parse(options.body), options.signal]);
            return { ok:true, headers:{get:()=> 'text/event-stream'}, body:{pipeThrough:()=>({getReader:()=>({
                read: async () => events.length ? {value:events.shift(),done:false} : {done:true},
                cancel: async () => { cancelled = true; }, releaseLock:()=>{},
            })})} };
        },
    });
    const source = fs.readFileSync(path.join(__dirname,'../modules/history-generation.js'),'utf8')
        .replace(/^export /gm,'').replace(/import\(/g,'importNative(');
    vm.runInContext(source + '\nthis.generate = generateHistory;',sandbox);
    return { calls, progress, core, native, get cancelled(){ return cancelled; },
        run: (signal = new AbortController().signal) => sandbox.generate({prompt:'Only new messages',signal,onProgress:p=>progress.push(p)}),
    };
}

test('Chat Completion streams native-decoded reasoning with quiet parameters and its own signal', async () => {
    const f = fixture(); const controller = new AbortController(); const result = await f.run(controller.signal);
    assert.equal(f.calls.find(c=>c[0]==='build')[1], 'quiet');
    const request = f.calls.find(c=>c[0]==='fetch');
    assert.equal(request[2].stream,true); assert.equal(request[2].n,1); assert.equal(request[3],controller.signal);
    assert.equal(f.native['/scripts/openai.js'].oai_settings.n,4);
    assert.equal(f.progress[0].reasoning,'Live thought'); assert.equal(f.progress[0].done,false);
    assert.equal(result.text,'Summary'); assert.equal(result.reasoning,'Live thought');
    assert.equal(f.cancelled,true);
});

test('text completion auto-parses reasoning incrementally without including it in the summary', async () => {
    const f = fixture('textgenerationwebui'); const result = await f.run();
    assert.equal(f.progress[0].text,''); assert.equal(f.progress[0].reasoning,'Test reasoning');
    assert.equal(result.text,'Summary'); assert.equal(result.reasoning,'Test reasoning');
});

test('nonstreaming fallback returns actual reasoning and cancellation never sends a new request', async () => {
    const f = fixture('koboldhorde',false); const result = await f.run();
    assert.equal(result.reasoning,'Non-streamed reasoning');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.run(controller.signal), {name:'AbortError'});
    assert.equal(f.calls.some(c=>c[0]==='fetch'),false);
});
