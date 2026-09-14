// Use SillyTavern's own request builders and stream decoders. Do not install
// a StreamingProcessor or a synthetic message in the user's actual chat.
export async function generateHistory({ prompt, signal, onProgress }) {
    const core = await import('/script.js');
    const reasoning = await import('/scripts/reasoning.js');
    const { power_user } = await import('/scripts/power-user.js');
    const api = core.main_api;
    if (core.is_send_press) throw new Error('Wait for the current chat generation to finish.');
    signal.throwIfAborted();
    const started = Date.now();
    let last = { text: '', reasoning: '', duration: 0, type: 'model' };
    let reasoningEnded = null;
    const report = (text, thoughts = '', done = false) => {
        // Match vanilla auto-parse, including an incomplete streamed prefix.
        const config = power_user.reasoning;
        let parsed = false;
        if (!thoughts && config.auto_parse && config.prefix && config.suffix) {
            if (text && config.prefix.startsWith(text) && text !== config.prefix && !done) text = '';
            else if (text.startsWith(config.prefix)) {
                const end = text.indexOf(config.suffix, config.prefix.length);
                thoughts = text.slice(config.prefix.length, end < 0 ? undefined : end);
                text = end < 0 ? '' : text.slice(end + config.suffix.length).trimStart();
                parsed = true;
            }
        }
        if (text && reasoningEnded === null) reasoningEnded = Date.now();
        last = { text, reasoning: thoughts, duration: (reasoningEnded ?? Date.now()) - started, type: parsed ? 'parsed' : 'model' };
        onProgress?.({ ...last, done });
        return last;
    };
    const stop = () => signal.throwIfAborted();
    if (!core.isStreamingEnabled() || !['openai', 'textgenerationwebui', 'kobold', 'novel'].includes(api)) {
        // Non-streaming APIs still expose returned reasoning after completion.
        const data = await core.generateRawData({ prompt, api });
        stop();
        return report(core.extractMessageFromData(data, api), reasoning.extractReasoningFromData(data, { mainApi: api }), true);
    }
    let raw = core.createRawPrompt(prompt, api, false, false, '', '');
    let stream;
    if (api === 'openai') {
        const oai = await import('/scripts/openai.js');
        const { getEventSourceStream } = await import('/scripts/sse-stream.js');
        const event = { chat: raw, dryRun: false };
        await core.eventSource.emit(core.event_types.CHAT_COMPLETION_PROMPT_READY, event);
        raw = event.chat;
        const source = oai.oai_settings.chat_completion_source;
        const model = oai.getChatCompletionModel();
        // Quiet parameters avoid multi-swipes, character prefill, and tools.
        // Only transport streaming is enabled; no global API setting changes.
        const { generate_data } = await oai.createGenerationParameters(oai.oai_settings, model, 'quiet', raw);
        generate_data.stream = true;
        await core.eventSource.emit(core.event_types.CHAT_COMPLETION_SETTINGS_READY, generate_data);
        stop();
        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST', headers: core.getRequestHeaders(), body: JSON.stringify(generate_data), signal,
        });
        if (!response.ok) {
            oai.tryParseStreamingError(response, await response.text());
            throw new Error(`Summary request failed (${response.status}).`);
        }
        if (!generate_data.stream || response.headers.get('content-type')?.includes('application/json')) {
            const data = await response.json();
            if (data.error) throw new Error(data.error.message || String(data.error));
            return report(core.extractMessageFromData(data, api), reasoning.extractReasoningFromData(data, { mainApi: api, chatCompletionSource: source }), true);
        }
        const reader = response.body.pipeThrough(getEventSourceStream()).getReader();
        const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
        let text = '';
        try {
            while (true) {
                stop();
                const { done, value } = await reader.read();
                if (done || value.data === '[DONE]') break;
                oai.tryParseStreamingError(response, value.data);
                text += oai.getStreamingReply(JSON.parse(value.data), state, { chatCompletionSource: source });
                report(text, state.reasoning);
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        return report(text, state.reasoning, true);
    }
    const event = { prompt: raw, dryRun: false };
    await core.eventSource.emit(core.event_types.GENERATE_AFTER_COMBINE_PROMPTS, event);
    raw = event.prompt;
    stop();
    if (api === 'textgenerationwebui') {
        const tc = await import('/scripts/textgen-settings.js');
        const data = await tc.getTextGenGenerationData(raw, core.amount_gen, false, false, null, 'quiet');
        stream = await tc.generateTextGenWithStreaming(data, signal);
    } else if (api === 'kobold') {
        const kai = await import('/scripts/kai-settings.js');
        const preset = core.koboldai_settings[core.koboldai_setting_names[kai.kai_settings.preset_settings]];
        const data = kai.kai_settings.preset_settings === 'gui'
            ? { prompt: raw, gui_settings: true, max_length: core.amount_gen, max_context_length: core.max_context, api_server: kai.kai_settings.api_server }
            : kai.getKoboldGenerationData(raw, preset, core.amount_gen, core.max_context, false, 'quiet');
        stream = await kai.generateKoboldWithStreaming(data, signal);
    } else {
        const nai = await import('/scripts/nai-settings.js');
        const preset = core.novelai_settings[core.novelai_setting_names[nai.nai_settings.preset_settings_novel]];
        const data = nai.getNovelGenerationData(raw, preset, core.amount_gen, false, false, null, 'quiet');
        stream = await nai.generateNovelWithStreaming(data, signal);
    }
    for await (const chunk of stream()) {
        stop();
        report(chunk.text ?? '', chunk.state?.reasoning ?? '');
    }
    return report(last.text, last.reasoning, true);
}

export async function createHistoryReasoningView(host) {
    const { ReasoningHandler, ReasoningState, isHiddenReasoningModel } = await import('/scripts/reasoning.js');
    const { power_user } = await import('/scripts/power-user.js');
    const { copyText } = await import('/scripts/utils.js');
    const template = document.querySelector('#message_template .mes_reasoning_details');
    if (!template) throw new Error('SillyTavern reasoning template was not found.');
    host.classList.add('mes', 'stplus-history-reasoning');
    host.setAttribute('mesid', '-1');
    const block = document.createElement('div');
    block.className = 'mes_block';
    const details = template.cloneNode(true);
    // Chat-bound edit/delete handlers must never target a real chat message.
    details.querySelectorAll('.mes_reasoning_actions > :not(.mes_reasoning_copy):not(.mes_reasoning_close_all)').forEach(e => e.remove());
    const dummy = document.createElement('span');
    dummy.className = 'mes_edit_add_reasoning';
    dummy.hidden = true;
    block.append(details, dummy);
    host.replaceChildren(block);
    const summary = details.querySelector('.mes_reasoning_summary');
    summary?.addEventListener('click', e => {
        // The native handler is delegated from document and assumes every
        // reasoning block belongs to a real chat message. This isolated
        // summary block must toggle itself without allowing that handler to
        // act on the user's chat messages.
        if (e.target.closest('.mes_reasoning_actions')) return;
        e.preventDefault();
        e.stopPropagation();
        details.open = !details.open;
        details.querySelector('.mes_reasoning_arrow')?.classList.toggle('fa-chevron-up', details.open);
        details.querySelector('.mes_reasoning_arrow')?.classList.toggle('fa-chevron-down', !details.open);
    });
    let handler = new ReasoningHandler();
    handler.messageDom = host;
    let scope = null;
    let signature = '';
    const copy = details.querySelector('.mes_reasoning_copy');
    copy?.addEventListener('pointerup', e => e.stopPropagation());
    copy?.addEventListener('click', async e => {
        e.preventDefault(); e.stopPropagation();
        await copyText(handler.reasoning);
        globalThis.toastr?.info?.('Copied!');
    });
    details.querySelector('.mes_reasoning_close_all')?.addEventListener('click', e => {
        e.preventDefault(); e.stopPropagation(); details.open = false;
    });
    return {
        update(data, key) {
            const nextSignature = JSON.stringify([data, key]);
            if (signature === nextSignature) return;
            signature = nextSignature;
            if (scope !== key) {
                details.open = power_user.reasoning.auto_expand;
                scope = key;
            }
            host.hidden = !data || (!data.reasoning && data.done && (!isHiddenReasoningModel() || !power_user.reasoning.show_hidden));
            if (!data) return;
            handler.reasoning = data.reasoning || '';
            handler.type = data.type || 'model';
            handler.startTime = new Date(0);
            handler.endTime = data.done || data.text ? new Date(data.duration || 1) : null;
            handler.state = handler.endTime ? (handler.reasoning ? ReasoningState.Done : ReasoningState.Hidden) : ReasoningState.Thinking;
            // updateDom only renders. init/process/finish require real chat IDs
            // and intentionally are not called for this isolated summary view.
            handler.updateDom(-1);
        },
    };
}
