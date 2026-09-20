import { power_user } from '/scripts/power-user.js';
import {
    persona_description_positions,
    setPersonaDescription,
    setUserAvatar,
    user_avatar,
} from '/scripts/personas.js';
import { save } from './settings-store.js';

const PERSONA_LIST_SELECTOR = '#user_avatar_block';
const TOOLBAR_BUTTON_ID = 'stplus-persona-combination-toggle';
const CHECKBOX_CLASS = 'stplus-persona-combine-checkbox';
const DECORATED_ATTRIBUTE = 'data-stplus-persona-combine';

let context = null;
let settings = null;
let personaObserver = null;
let refreshScheduled = false;
let applying = false;
let appliedSignature = '';
let fallbackState = null;
let cardClickHandlerInstalled = false;

/**
 * Combine persona descriptions without changing their internal formatting.
 * The newline is intentional: it keeps each persona's text as a separate
 * prompt block while avoiding the literal `/n` typo that would leak into the
 * prompt.
 */
export function combinePersonaDescriptions(ids, descriptions) {
    return ids
        .map((id) => String(descriptions?.[id]?.description ?? '').trim())
        .filter(Boolean)
        .join('\n');
}

function isEnabled() {
    return settings?.personaCombinationEnabled !== false;
}

function getSelectedIds() {
    const available = power_user?.personas ?? {};
    const selected = Array.isArray(settings?.personaCombinationSelected)
        ? settings.personaCombinationSelected
        : [];
    return [...new Set(selected.filter((id) => typeof id === 'string' && id in available))];
}

function persistSelection(ids) {
    settings.personaCombinationSelected = [...ids];
    save();
}

function cloneDescriptor(descriptor) {
    if (!descriptor || typeof descriptor !== 'object') return null;
    return { ...descriptor };
}

function captureFallback() {
    if (fallbackState || !user_avatar) return;
    fallbackState = {
        avatar: user_avatar,
        descriptor: cloneDescriptor(power_user.persona_descriptions?.[user_avatar]),
    };
}

function setCombinedPersonaState(ids) {
    const first = power_user.persona_descriptions?.[ids[0]] ?? {};
    power_user.persona_description = combinePersonaDescriptions(ids, power_user.persona_descriptions);
    power_user.persona_description_position = first.position ?? persona_description_positions.IN_PROMPT;
    power_user.persona_description_depth = first.depth ?? 2;
    power_user.persona_description_role = first.role ?? 0;
    power_user.persona_description_lorebook = first.lorebook ?? '';
    setPersonaDescription();
}

async function restoreFallback() {
    if (!fallbackState) return;
    const state = fallbackState;
    fallbackState = null;
    appliedSignature = '';

    if (user_avatar !== state.avatar) {
        await setUserAvatar(state.avatar, { toastPersonaNameChange: false, navigateToCurrent: false });
    }

    if (state.descriptor) {
        power_user.persona_descriptions[state.avatar] = {
            ...(power_user.persona_descriptions[state.avatar] ?? {}),
            ...state.descriptor,
        };
        power_user.persona_description = state.descriptor.description ?? '';
        power_user.persona_description_position = state.descriptor.position ?? persona_description_positions.IN_PROMPT;
        power_user.persona_description_depth = state.descriptor.depth ?? 2;
        power_user.persona_description_role = state.descriptor.role ?? 0;
        power_user.persona_description_lorebook = state.descriptor.lorebook ?? '';
        setPersonaDescription();
    }
    save();
}

async function applySelection(ids = getSelectedIds()) {
    if (!isEnabled()) {
        await restoreFallback();
        return;
    }
    if (!ids.length) {
        await restoreFallback();
        return;
    }

    captureFallback();
    const signature = ids.join('\u0000');
    const description = combinePersonaDescriptions(ids, power_user.persona_descriptions);
    if (signature === appliedSignature && power_user.persona_description === description) return;

    applying = true;
    try {
        if (user_avatar !== ids[0]) {
            await setUserAvatar(ids[0], { toastPersonaNameChange: false, navigateToCurrent: false });
        }
        setCombinedPersonaState(ids);
        appliedSignature = signature;
        save();
    } finally {
        applying = false;
    }
}

function getPersonaCards() {
    const list = document.querySelector(PERSONA_LIST_SELECTOR);
    return list instanceof HTMLElement
        ? [...list.querySelectorAll('.avatar-container[data-avatar-id]')]
        : [];
}

function updateToolbar() {
    const list = document.querySelector(PERSONA_LIST_SELECTOR);
    if (!(list instanceof HTMLElement) || !isEnabled()) {
        document.getElementById(TOOLBAR_BUTTON_ID)?.remove();
        return;
    }

    let button = document.getElementById(TOOLBAR_BUTTON_ID);
    if (!(button instanceof HTMLButtonElement)) {
        button = document.createElement('button');
        button.type = 'button';
        button.id = TOOLBAR_BUTTON_ID;
        button.className = 'menu_button menu_button_icon stplus-persona-combination-toolbar';
        button.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const allIds = Object.keys(power_user.personas ?? {});
            const selected = getSelectedIds();
            const next = allIds.length > 0 && allIds.every((id) => selected.includes(id)) ? [] : allIds;
            persistSelection(next);
            await applySelection(next);
            decoratePersonaList();
            updateToolbar();
        });
    }

    const allIds = Object.keys(power_user.personas ?? {});
    const selected = getSelectedIds();
    const allSelected = allIds.length > 0 && allIds.every((id) => selected.includes(id));
    button.title = allSelected ? 'Clear all persona selections' : 'Select all personas';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = `<i class="fa-solid ${allSelected ? 'fa-square-xmark' : 'fa-check-double'}" aria-hidden="true"></i>`;

    const gridToggle = document.getElementById('persona_grid_toggle');
    const host = gridToggle?.parentElement ?? list.parentElement;
    if (host instanceof HTMLElement && button.parentElement !== host) host.appendChild(button);
}

function decoratePersonaList() {
    const selected = new Set(getSelectedIds());
    for (const card of getPersonaCards()) {
        const avatarId = card.getAttribute('data-avatar-id');
        if (!avatarId) continue;
        let checkbox = card.querySelector(`.${CHECKBOX_CLASS}`);
        if (!(checkbox instanceof HTMLInputElement)) {
            checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = CHECKBOX_CLASS;
            checkbox.dataset.avatarId = avatarId;
            checkbox.addEventListener('click', (event) => {
                event.stopPropagation();
            });
            checkbox.addEventListener('change', async (event) => {
                event.stopPropagation();
                const ids = new Set(getSelectedIds());
                if (checkbox.checked) ids.add(avatarId);
                else ids.delete(avatarId);
                const next = [...ids];
                persistSelection(next);
                await applySelection(next);
                decoratePersonaList();
                updateToolbar();
            });
            card.appendChild(checkbox);
        }
        checkbox.checked = selected.has(avatarId);
        checkbox.setAttribute('aria-label', `Include ${power_user.personas?.[avatarId] ?? avatarId} in combined persona`);
        card.setAttribute(DECORATED_ATTRIBUTE, '1');
        card.classList.toggle('stplus-persona-combine-selected', selected.has(avatarId));
    }
    updateToolbar();
}

function removeDecorations() {
    document.querySelectorAll(`.${CHECKBOX_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`[${DECORATED_ATTRIBUTE}]`).forEach((element) => {
        element.classList.remove('stplus-persona-combine-selected');
        element.removeAttribute(DECORATED_ATTRIBUTE);
    });
    document.getElementById(TOOLBAR_BUTTON_ID)?.remove();
}

function handlePersonaCardClick(event) {
    if (!isEnabled()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(`.${CHECKBOX_CLASS}`)) return;
    const card = target?.closest('.avatar-container[data-avatar-id]');
    const list = document.querySelector(PERSONA_LIST_SELECTOR);
    if (!(card instanceof HTMLElement) || !(list instanceof HTMLElement) || !list.contains(card)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
}

function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    const run = () => {
        refreshScheduled = false;
        if (!isEnabled()) {
            removeDecorations();
            if (!applying) void restoreFallback();
            return;
        }
        decoratePersonaList();
        if (!applying && getSelectedIds().length) void applySelection();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else window.setTimeout(run, 0);
}

function registerLifecycleEvents() {
    const events = ['CHAT_CHANGED', 'PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_CREATED', 'PERSONA_RENAMED', 'PERSONA_DELETED'];
    for (const name of events) {
        const event = context?.eventTypes?.[name];
        if (event && context?.eventSource?.on) context.eventSource.on(event, scheduleRefresh);
    }
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    if (!personaObserver && document.body) {
        personaObserver = new MutationObserver((mutations) => {
            if (mutations.some((mutation) => mutation.target instanceof Element && mutation.target.closest(PERSONA_LIST_SELECTOR))) {
                scheduleRefresh();
            }
        });
        personaObserver.observe(document.body, { childList: true, subtree: true });
    }
    if (!cardClickHandlerInstalled) {
        document.addEventListener('click', handlePersonaCardClick, true);
        cardClickHandlerInstalled = true;
    }
    registerLifecycleEvents();
    refresh();
}

export function refresh() {
    if (!settings) return;
    if (!isEnabled()) {
        removeDecorations();
        if (!applying) void restoreFallback();
        return;
    }
    decoratePersonaList();
    const ids = getSelectedIds();
    if (ids.length && !applying) void applySelection(ids);
}
