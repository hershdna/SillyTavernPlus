# Alt Greeting Reorder

A SillyTavern extension that adds a numeric position control to every alternate greeting in the character editor.

## Use

1. Open a character's **Alt. Greetings** editor.
2. Enter the desired 1-based position in a greeting's **Position** field.
3. Press Enter, use **Move**, or leave the field to apply the move.
4. Close the native greeting editor to let SillyTavern save the character normally.

The extension keeps SillyTavern's native editor and save flow intact. It only rewrites the greeting values in their existing editor fields and emits the same input events used by the native editor.

## Installation

Copy this repository into:

`SillyTavern/public/scripts/extensions/third-party/AltGreetingReorder`

Then enable it from SillyTavern's Extensions panel or restart SillyTavern.
