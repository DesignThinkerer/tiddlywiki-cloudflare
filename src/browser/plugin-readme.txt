This plugin is the admin wiki's side of [[TiddlyWiki on Cloudflare|https://github.com/DesignThinkerer/tiddlywiki-cloudflare]]: the conflict guard (a save that would overwrite someone else's is refused and kept as a copy), the tiddler list and the device copy (tiddlers loaded onto this device, so a later page load fetches only what changed), the backup alert, the page publisher (the page the public site serves), the restore import (the backup's files dropped onto the wiki), the control panel's Cloudflare tab (Saving → Cloudflare: the setup check, how backups go), the outbox (editing offline: every change kept on the device until the worker has it) and the cold start (the service worker that opens the wiki with no network).

The worker puts this plugin in every page it builds, so it always matches the worker — the version above is the worker's. It isn't stored in the wiki.

A part edited here is an override, as with any plugin: it stays through the worker's updates, and this dialog marks it. Delete the override to get the worker's part back.

Settings: the //settings// tab. The worker's own settings (the public site's address, backups, purges) live in the Cloudflare dashboard, README 2.5.
