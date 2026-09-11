# SillyTavernPlus

A SillyTavern extension with small quality-of-life tools for the character and World Info editors.

## Features

- Reorder alternate greetings with numeric position controls.
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
- Open a dedicated settings window from the top bar to enable or disable modules independently, organized under World Info / Lorebooks, Characters, and MovingUI. MovingUI resizing, frontmost behavior, open-on-top behavior, and unbounded resizing are enabled by default.
- Floating window position and size persist between sessions.

## Installation

Copy this repository into:

`SillyTavern/public/scripts/extensions/third-party/SillyTavernPlus`

Then enable it from SillyTavern's Extensions panel or restart SillyTavern.
