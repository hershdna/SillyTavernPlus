const TAG_HEADER_PREFIX = /^\s*-\s*/;
const SECTION_HEADER = /^\s*-\s*[^:\n]+:\s*/;

let context = null;
let settings = null;
let listenerBound = false;

export function normalizeTags(tags) {
    const values = Array.isArray(tags) ? tags : String(tags ?? '').split(/[\n,]/);
    const seen = new Set();
    return values
        .map((tag) => String(tag ?? '').trim())
        .filter((tag) => {
            if (!tag || seen.has(tag)) return false;
            seen.add(tag);
            return true;
        });
}

function isEnabled() {
    return settings?.characterDescriptionTagFilterEnabled !== false;
}

function getDefinedTags() {
    return normalizeTags(settings?.characterDescriptionTags);
}

function getLatestMessageText() {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const latest = chat.at(-1);
    return typeof latest?.mes === 'string' ? latest.mes : '';
}

export function findActiveTags(message, tags) {
    const source = String(message ?? '');
    const active = new Set();
    for (const tag of normalizeTags(tags)) {
        // Tags must be explicitly bracketed in the latest message. This keeps
        // ordinary prose from changing the outgoing character description.
        if (source.includes(`[${tag}]`)) active.add(tag);
    }
    return active;
}

function getHeaderTag(line, tags) {
    const prefixMatch = String(line).match(TAG_HEADER_PREFIX);
    if (!prefixMatch) return null;
    const remainder = line.slice(prefixMatch[0].length);
    for (const tag of tags) {
        if (remainder.startsWith(`${tag}:`)) return tag;
    }
    return null;
}

export function filterDescriptionByTags(description, activeTags, tags) {
    const source = String(description ?? '');
    const definedTags = normalizeTags(tags);
    if (!source || !definedTags.length) return source;

    const sections = [];
    let section = { tag: null, lines: [] };
    for (const line of source.split(/\r?\n/)) {
        const tag = getHeaderTag(line, definedTags);
        // Every bullet-style header begins a new category. Undefined headers
        // remain unfiltered, but must not be swallowed by a preceding pruned
        // recognized category.
        if (tag || SECTION_HEADER.test(line)) {
            sections.push(section);
            section = { tag, lines: [line] };
        } else {
            section.lines.push(line);
        }
    }
    sections.push(section);

    const selected = activeTags instanceof Set ? activeTags : new Set(activeTags ?? []);
    return sections
        .filter((entry) => entry.tag === null || selected.has(entry.tag))
        .map((entry) => entry.lines.join('\n'))
        .join('\n')
        .trim();
}

export function getFilteredDescription(description, latestMessage, tags) {
    const definedTags = normalizeTags(tags);
    return filterDescriptionByTags(description, findActiveTags(latestMessage, definedTags), definedTags);
}

function handleBeforeCombinePrompts(data) {
    if (!isEnabled() || !data || typeof data.description !== 'string') return;
    data.description = getFilteredDescription(data.description, getLatestMessageText(), getDefinedTags());
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    if (listenerBound) return;
    const event = context?.eventTypes?.GENERATE_BEFORE_COMBINE_PROMPTS;
    if (!event || !context?.eventSource?.on) return;
    context.eventSource.on(event, handleBeforeCombinePrompts);
    listenerBound = true;
}

export function refresh() {
    // Settings are read at prompt time; no DOM or card mutation is needed.
}
