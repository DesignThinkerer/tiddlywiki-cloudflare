''Disabling it here turns all of this off at the next load, on every device:'' saves can overwrite each other, offline changes aren't kept, no backup alert shows, the page isn't published, and the Cloudflare tab is gone. To turn the modules off on purpose, set `CONFLICT_GUARD` to `off`; to get them back, tick the plugin on again and reload ([[operating 3.19|https://github.com/DesignThinkerer/tiddlywiki-cloudflare/blob/main/docs/operating.md#319-the-browser-modules-off-and-checking-theyre-on]]).

The admin wiki's side of [[TiddlyWiki on Cloudflare|https://github.com/DesignThinkerer/tiddlywiki-cloudflare]]: the conflict guard, the tiddler list and the device copy, the backup alert, the page publisher, the restore import, the Cloudflare tab (Saving), the outbox (editing offline) and the service worker (opening offline).

The worker puts it in every page it builds: it always matches the worker, whose version is above, and isn't stored in the wiki. A part edited here is an override, as with any plugin, and stays until deleted.

Settings: the //settings// tab. What this browser keeps, and forgetting it: the //device// tab. The worker's own settings (the public site, backups, purges): the Cloudflare dashboard, [[setup 2.5|https://github.com/DesignThinkerer/tiddlywiki-cloudflare/blob/main/docs/setup.md#25-the-worker]].
