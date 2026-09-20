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
const PRIMARY_CHECKBOX_CLASS = 'stplus-persona-primary-checkbox';
const CONTROLS_CLASS = 'stplus-persona-combine-controls';
const DECORATED_ATTRIBUTE = 'data-stplus-persona-combine';

let context = null;
let settings = null;
let personaObserver = null;
let refreshScheduled = false;
let applying = false;
let appliedSignature = '';
let fallbackState = null;

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

export function orderPersonaIds(ids, primaryId) {
    const unique = [...new Set(ids)];
    if (!primaryId || !unique.includes(primaryId)) return unique;
    return [primaryId, ...unique.filter((id) => id !== primaryId)];
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

function getPrimaryId(selected = getSelectedIds()) {
    const primary = settings?.personaCombinationPrimary;
    return typeof primary === 'string' && selected.includes(primary) ? primary : null;
}

function getOrderedSelectedIds() {
    return orderPersonaIds(getSelectedIds(), getPrimaryId());
}

function persistSelection(ids, primary = getPrimaryId(ids)) {
    settings.personaCombinationSelected = [...ids];
    settings.personaCombinationPrimary = typeof primary === 'string' && ids.includes(primary) ? primary : null;
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
    restoreVisiblePersonaDescription();
}

function restoreVisiblePersonaDescription() {
    const editor = document.getElementById('persona_description');
    const descriptor = power_user.persona_descriptions?.[user_avatar];
    if (!(editor instanceof HTMLTextAreaElement) || !descriptor) return;
    // Keep the native editor focused on the persona the user just clicked.
    // The combined value remains in power_user.persona_description for prompt
    // injection, but must not replace the description shown in the editor.
    editor.value = descriptor.description ?? '';
}

function isPersonaEditorFocused() {
    const editor = document.getElementById('persona_description');
    return editor instanceof HTMLTextAreaElement && document.activeElement === editor;
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

async function applySelection(ids = getOrderedSelectedIds()) {
    if (!isEnabled()) {
        await restoreFallback();
        return;
    }
    if (!ids.length) {
        await restoreFallback();
        return;
    }

    // Native persona editing updates the live description while the textarea
    // is focused. Never refresh the combined state over a character the user
    // is currently typing, especially whitespace-only edits.
    if (isPersonaEditorFocused()) return;

    captureFallback();
    const signature = ids.join('\u0000');
    const description = combinePersonaDescriptions(ids, power_user.persona_descriptions);
    if (signature === appliedSignature) {
        if (power_user.persona_description !== description) {
            setCombinedPersonaState(ids);
            restoreVisiblePersonaDescription();
        }
        return;
    }

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
            persistSelection(next, getPrimaryId(next) ?? next[0] ?? null);
            await applySelection(orderPersonaIds(next, getPrimaryId(next)));
            decoratePersonaList();
            updateToolbar();
        });
    }

    const allIds = Object.keys(power_user.personas ?? {});
    const selected = getSelectedIds();
    const allSelected = allIds.length > 0 && allIds.every((id) => selected.includes(id));
    button.title = allSelected ? 'Clear all persona selections' : 'Select all personas';
    button.setAttribute('aria-label', button.title);
    const iconClass = allSelected ? 'fa-square-xmark' : 'fa-check-double';
    if (button.dataset.stplusIcon !== iconClass) {
        button.innerHTML = `<i class="fa-solid ${iconClass}" aria-hidden="true"></i>`;
        button.dataset.stplusIcon = iconClass;
    }

    const gridToggle = document.getElementById('persona_grid_toggle');
    const host = gridToggle?.parentElement ?? list.parentElement;
    if (host instanceof HTMLElement && button.parentElement !== host) host.appendChild(button);
}

function decoratePersonaList() {
    const selected = new Set(getSelectedIds());
    const primary = getPrimaryId([...selected]);
    for (const card of getPersonaCards()) {
        const avatarId = card.getAttribute('data-avatar-id');
        if (!avatarId) continue;
        let controls = card.querySelector(`.${CONTROLS_CLASS}`);
        if (!(controls instanceof HTMLElement)) {
            const legacyCheckbox = [...card.children].find((element) => element.classList?.contains(CHECKBOX_CLASS));
            controls = document.createElement('div');
            controls.className = CONTROLS_CLASS;
            controls.title = 'Persona combination controls';
            controls.addEventListener('click', (event) => event.stopPropagation());

            const includeLabel = document.createElement('label');
            includeLabel.className = 'stplus-persona-control stplus-persona-include-control';
            includeLabel.title = 'Include this persona in the combined prompt';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = CHECKBOX_CLASS;
            checkbox.dataset.avatarId = avatarId;
            checkbox.addEventListener('change', async (event) => {
                event.stopPropagation();
                const ids = new Set(getSelectedIds());
                if (checkbox.checked) ids.add(avatarId);
                else ids.delete(avatarId);
                const next = [...ids];
                const nextPrimary = getPrimaryId(next) === avatarId && !checkbox.checked ? null : getPrimaryId();
                persistSelection(next, nextPrimary);
                await applySelection(orderPersonaIds(next, nextPrimary));
                decoratePersonaList();
                updateToolbar();
            });
            const includeMarker = document.createElement('span');
            includeMarker.className = 'stplus-persona-control-marker';
            includeMarker.textContent = 'C';
            includeMarker.setAttribute('aria-hidden', 'true');
            includeLabel.append(checkbox, includeMarker);

            const primaryLabel = document.createElement('label');
            primaryLabel.className = 'stplus-persona-control stplus-persona-primary-control';
            primaryLabel.title = 'Use this as the primary persona (first in the combined prompt)';
            const primaryCheckbox = document.createElement('input');
            primaryCheckbox.type = 'checkbox';
            primaryCheckbox.className = PRIMARY_CHECKBOX_CLASS;
            primaryCheckbox.dataset.avatarId = avatarId;
            primaryCheckbox.addEventListener('change', async (event) => {
                event.stopPropagation();
                const ids = new Set(getSelectedIds());
                if (primaryCheckbox.checked) ids.add(avatarId);
                const next = [...ids];
                const nextPrimary = primaryCheckbox.checked ? avatarId : null;
                persistSelection(next, nextPrimary);
                await applySelection(orderPersonaIds(next, nextPrimary));
                decoratePersonaList();
                updateToolbar();
            });
            const primaryMarker = document.createElement('span');
            primaryMarker.className = 'stplus-persona-control-marker';
            primaryMarker.textContent = 'P';
            primaryMarker.setAttribute('aria-hidden', 'true');
            primaryLabel.append(primaryCheckbox, primaryMarker);

            controls.append(includeLabel, primaryLabel);
            card.appendChild(controls);
            legacyCheckbox?.remove();
        }

        const checkbox = controls.querySelector(`.${CHECKBOX_CLASS}`);
        const primaryCheckbox = controls.querySelector(`.${PRIMARY_CHECKBOX_CLASS}`);
        if (!(checkbox instanceof HTMLInputElement) || !(primaryCheckbox instanceof HTMLInputElement)) continue;
        checkbox.checked = selected.has(avatarId);
        primaryCheckbox.checked = primary === avatarId;
        checkbox.setAttribute('aria-label', `Include ${power_user.personas?.[avatarId] ?? avatarId} in combined persona`);
        primaryCheckbox.setAttribute('aria-label', `Make ${power_user.personas?.[avatarId] ?? avatarId} the primary persona`);
        card.setAttribute(DECORATED_ATTRIBUTE, '1');
        card.classList.toggle('stplus-persona-combine-selected', selected.has(avatarId));
    }
    updateToolbar();
}

function removeDecorations() {
    document.querySelectorAll(`.${CONTROLS_CLASS}`).forEach((element) => element.remove());
    document.querySelectorAll(`[${DECORATED_ATTRIBUTE}]`).forEach((element) => {
        element.classList.remove('stplus-persona-combine-selected');
        element.removeAttribute(DECORATED_ATTRIBUTE);
    });
    document.getElementById(TOOLBAR_BUTTON_ID)?.remove();
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
        if (!applying && !isPersonaEditorFocused() && getSelectedIds().length) void applySelection();
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
            const personaMutation = mutations.some((mutation) => {
                const target = mutation.target instanceof Element ? mutation.target : null;
                if (target?.closest(`${PERSONA_LIST_SELECTOR}, #persona-management-button`)) return true;
                return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
                    if (!(node instanceof Element)) return false;
                    return node.matches(`${PERSONA_LIST_SELECTOR}, #persona-management-button`)
                        || Boolean(node.querySelector(`${PERSONA_LIST_SELECTOR}, #persona-management-button`));
                });
            });
            if (personaMutation) {
                scheduleRefresh();
            }
        });
        personaObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
            childList: true,
            subtree: true,
        });
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
    const ids = getOrderedSelectedIds();
    if (ids.length && !applying && !isPersonaEditorFocused()) void applySelection(ids);
}
