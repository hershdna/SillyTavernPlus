# SillyTavernPlus

A SillyTavern extension with small quality-of-life tools for the character and World Info editors.

## Features

- Reorder alternate greetings with numeric position controls.
- Double-click a rendered chat message to edit its visible text in place while preserving its existing formatting, with vanilla-style confirm and cancel controls.
- Keep swipe/reroll alternatives and their continuations in one navigable chat-branch tree, with previews, jump-to-node navigation, search, and vanilla JSONL branch export.
- Scope branch data and controls to the currently open chat; changing or closing a chat closes the branch window and clears its in-memory graph.
- Reset branch state on SillyTavern chat creation/deletion events and guard stored metadata with the active chat identity.
- Persist branch metadata through SillyTavern's dedicated metadata save path so jumps survive reloads and reopening the chat.
- Remain compatible with vanilla chats by using SillyTavern's native `swipes`/`swipe_id` fields, storing extra data only in chat metadata, and exporting a selected path as an ordinary JSONL chat.
- Open SillyTavernPlus module settings from a dedicated top-toolbar icon (this icon does not launch Worlds/Lorebooks).
- Open the floating Worlds/Lorebooks editor through SillyTavern's native World Info icon.
- Use the native World Info editor in a floating window that can be moved and resized.
- Resize the floating window from any corner.
- Add four-corner resizing to every MovingUI panel, including dynamic windows from third-party extensions such as GalleryPlus.
- Bring any clicked MovingUI window to the front, including windows supplied by external extensions.
- Open newly-created MovingUI windows on top automatically, including windows supplied by external extensions.
- Keep the main chat text window out of click-to-front ordering so opening other windows cannot bury them behind it.
- Keep transient controls such as Gallery folder autocomplete menus above their owning floating window.
- Optionally include previous assistant thinking output in World Info scanning, with a configurable reasoning-turn depth.
- Generate branch-aware chat history summaries from a custom prompt, store them in chat metadata, inject the active summary at a configurable in-chat depth, and detect when jumps, edits, swipes, or deletions make a summary stale.
- Open a dedicated settings window from the top bar to enable or disable modules independently, organized under World Info / Lorebooks, Characters, Chat, and MovingUI. MovingUI resizing, reposition handles, frontmost behavior, open-on-top behavior, unbounded resizing, and formatted message editing are enabled by default.
- Floating window position and size persist between sessions.

## Chat branches

Open the **Chat Tree** toolbar icon while a chat is active. The window is a navigator: each swipe is a sibling at its turn depth, and later swipes are children of the exact message they continue. Select a node and choose **Jump to Here** to make that path active; continuing the conversation records the new continuation in the same chat’s `stplusBranchingChats` metadata. Scroll over the tree to zoom toward the pointer and drag the tree to pan. This does not create a new entry in SillyTavern’s chat browser.

SillyTavern’s native **Branch** message action remains unchanged and continues to create a separate vanilla chat. To turn an ST+ path into a normal chat file, select it and choose **Export Branch**, then import the generated JSONL through SillyTavern’s chat controls.

## Chat History

Open the book icon in the top toolbar while a chat is open. **Generate summary** uses the selected SillyTavern API and your summary instructions. **Update summary** sends the previous summary as context alongside only messages after its bookmark; it does not add an OOC exchange to the chat. Requests use `generateRaw` so the ordinary full chat prompt is not included a second time.

Edit the summary directly and choose **Save edited summary**. Editing an existing summary keeps its original bookmark. Configure the injection header, depth, and injection checkbox in the same window. Summaries and their source checkpoints live in the chat's `stplusChatHistory` metadata in its JSONL file; ordinary vanilla message rows remain unchanged. Generation uses tokens from the configured API.

Edits, deletions, swipes and tree jumps are checked against the covered message path and text fingerprints. A stale summary is excluded until you choose **Keep and use**, **Prune summary** (archives the whole affected summary), or **Regenerate here**. Keeping applies to that specific path and source state. The module cannot reliably remove individual facts from a merged prose summary; regenerate for that. Updates retain earlier checkpoints for earlier parts of a branch. Monitoring continues while the window is closed.

If you change chats or branches during generation, the result is rejected rather than attached to a different conversation. Unsaved summary drafts survive UI refreshes within the session and are scoped to their chat and path.

## Installation

Copy this repository into:

`SillyTavern/public/scripts/extensions/third-party/SillyTavernPlus`

Then enable it from SillyTavern's Extensions panel or restart SillyTavern.
