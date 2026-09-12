# SillyTavernPlus

A SillyTavern extension with small quality-of-life tools for the character and World Info editors.

## Features

- Reorder alternate greetings with numeric position controls.
- Keep swipe/reroll variants and their continuations in one navigable chat-branch tree, with previews, jump-to-node navigation, search, and vanilla JSONL branch export.
- Scope branch data and controls to the currently open chat; changing or closing a chat closes the branch window and clears its in-memory graph.
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
- Open a dedicated settings window from the top bar to enable or disable modules independently, organized under World Info / Lorebooks, Characters, and MovingUI. MovingUI resizing, reposition handles, frontmost behavior, open-on-top behavior, and unbounded resizing are enabled by default.
- Floating window position and size persist between sessions.

## Chat branches

Open **Branches** while a chat is active. The window is a navigator: each message variant is a sibling at its turn depth, and later variants are children of the exact message they continue. Select a node and choose **Jump to Here** to make that path active; continuing the conversation records the new continuation in the same chat’s `stplusBranchingChats` metadata. This does not create a new entry in SillyTavern’s chat browser.

SillyTavern’s native **Branch** message action remains unchanged and continues to create a separate vanilla chat. To turn an ST+ path into a normal chat file, select it and choose **Export Branch**, then import the generated JSONL through SillyTavern’s chat controls.

## Installation

Copy this repository into:

`SillyTavern/public/scripts/extensions/third-party/SillyTavernPlus`

Then enable it from SillyTavern's Extensions panel or restart SillyTavern.
