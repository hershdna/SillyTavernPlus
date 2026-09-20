import { power_user } from '/scripts/power-user.js';
import {
    persona_description_positions,
    setUserAvatar,
    user_avatar,
} from '/scripts/personas.js';
import { save } from './settings-store.js';

const PERSONA_LIST_SELECTOR = '#user_avatar_block';
const TOOLBAR_BUTTON_ID = 'stplus-persona-combination-toggle';
const COMBINATION_PROMPT_KEY = 'stplus_persona_combination';
const CHECKBOX_CLASS = 'stplus-persona-combine-checkbox';
const PRIMARY_CHECKBOX_CLASS = 'stplus-persona-primary-checkbox';
const CONTROLS_CLASS = 'stplus-persona-combine-controls';
const DECORATED_ATTRIBUTE = 'data-stplus-persona-combine';

let context = null;
let settings = null;
let personaObserver = null;
let refreshScheduled = false;
let applying = false;

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
    if (typeof primary === 'string' && selected.includes(primary)) return primary;
    if (typeof user_avatar === 'string' && selected.includes(user_avatar)) return user_avatar;
    return selected[0] ?? null;
}

function getOrderedSelectedIds() {
    return orderPersonaIds(getSelectedIds(), getPrimaryId());
}

function persistSelection(ids, primary = getPrimaryId(ids)) {
    settings.personaCombinationSelected = [...ids];
    settings.personaCombinationPrimary = typeof primary === 'string' && ids.includes(primary) ? primary : null;
    save();
}

function clearCombinationPrompt() {
    context?.setExtensionPrompt?.(COMBINATION_PROMPT_KEY, '', 0, 0);
}

/**
 * Leave SillyTavern's native persona state untouched. The native primary
 * persona is injected by SillyTavern exactly as usual; this module only adds
 * the other selected descriptions after it through an extension prompt.
 */
function setCombinationPrompt(ids) {
    const primaryId = ids[0];
    const extras = combinePersonaDescriptions(ids.slice(1), power_user.persona_descriptions);
    const primary = power_user.persona_descriptions?.[primaryId];
    if (!extras || !primary || primary.position === persona_description_positions.NONE) {
        clearCombinationPrompt();
        return;
    }

    if (primary.position === persona_description_positions.AT_DEPTH) {
        context?.setExtensionPrompt?.(
            COMBINATION_PROMPT_KEY,
            extras,
            1,
            primary.depth ?? 2,
            false,
            primary.role ?? 0,
        );
        return;
    }

    // For native in-prompt and author-note placements, SillyTavern's native
    // persona prompt is created first. A regular in-prompt extension is then
    // appended without changing the native persona's position, depth, role,
    // lorebook, editor value, or other native behavior.
    context?.setExtensionPrompt?.(COMBINATION_PROMPT_KEY, extras, 0, 0);
}

async function applySelection(ids = getOrderedSelectedIds()) {
    if (!isEnabled()) {
        clearCombinationPrompt();
        return;
    }
    if (!ids.length) {
        clearCombinationPrompt();
        return;
    }

    const ordered = orderPersonaIds(ids, getPrimaryId(ids));
    const primaryId = ordered[0];
    applying = true;
    try {
        // Selecting a primary uses the native persona switch, so all native
        // current-persona behavior remains authoritative.
        if (user_avatar !== primaryId) {
            await setUserAvatar(primaryId, { toastPersonaNameChange: false, navigateToCurrent: false });
        }
        setCombinationPrompt(ordered);
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
                await applySelection(next);
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
                await applySelection(next);
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
            if (!applying) clearCombinationPrompt();
            return;
        }
        decoratePersonaList();
        if (!applying) void applySelection();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else window.setTimeout(run, 0);
}

function registerLifecycleEvents() {
    const events = ['CHAT_CHANGED', 'PERSONA_CHANGED', 'PERSONA_UPDATED', 'PERSONA_CREATED', 'PERSONA_RENAMED', 'PERSONA_DELETED'];
    for (const name of events) {
        const event = context?.eventTypes?.[name];
        if (event && context?.eventSource?.on) {
            context.eventSource.on(event, () => {
                // A native persona click is authoritative. Keep the selected
                // native persona as primary instead of switching it back to a
                // stale combination setting during the refresh.
                if (name === 'PERSONA_CHANGED' && !applying && user_avatar && power_user.personas?.[user_avatar]) {
                    const selected = new Set(getSelectedIds());
                    selected.add(user_avatar);
                    persistSelection([...selected], user_avatar);
                }
                scheduleRefresh();
            });
        }
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
        if (!applying) clearCombinationPrompt();
        return;
    }
    decoratePersonaList();
    const ids = getOrderedSelectedIds();
    if (ids.length && !applying) void applySelection(ids);
    else if (!ids.length) clearCombinationPrompt();
}
