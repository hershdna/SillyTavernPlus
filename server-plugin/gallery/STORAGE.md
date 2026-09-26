# Gallery storage redirection

Install all files in this server-plugin/gallery directory into plugins/SillyTavernPlusGallery and restart SillyTavern. Server component 1.6.0 adds the gallery toolbar's **Gallery storage location** control.

The destination is an existing absolute directory accessible for reading and writing by the server process. Local disks, removable drives, mapped drives and UNC shares can be used subject to OS permissions. Network directory symlinks on Windows may require Developer Mode or the service account's symlink privilege. An invalid/inaccessible destination reports an error without changing the current location. Do not select a drive root or the original gallery/its parent.

All characters for the current account use this location. Character folders must be directly inside the destination. The original `user/images` directory becomes a directory link, so native URLs, uploads, lists, deletion and third-party gallery integrations continue to work without core modifications. The redirect persists across server restarts and disabling the frontend module. A disconnected target is not replaced with local storage.

Existing local media is retained at the original directory name plus `.stplus-local`, not automatically copied, moved to the destination, merged or deleted. To reclaim existing disk space, stop SillyTavern and manually transfer that retained media into the destination, handling filename conflicts. Keep the retained directory itself for restoration. New uploads immediately use the destination. **Restore local storage** restores the retained directory; it does not move or delete external files. Changes affect every tab using this account; finish pending uploads before changing locations.

The sibling `.stplus-storage.json` file records the managed target. Unmanaged directory links and mismatched records are refused rather than overwritten. Directory changes roll back on operational errors. After an abrupt process/power interruption during switching, inspect the directory/link and retained copy before manual recovery; do not delete media.
