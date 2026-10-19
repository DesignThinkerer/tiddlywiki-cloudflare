/*\
title: $:/cfworker/device.js
type: application/javascript
module-type: startup

The plugin's device tab (design 1.14), about what this browser keeps of the wiki: the device copy
(the tiddlers loaded here, $:/cfworker/list-sync.js), the outbox (the changes not yet sent,
$:/cfworker/outbox.js) and the service worker's files (service-worker.js).
- Measure: the tiddlers kept of those the worker lists, with their size; what waits in the outbox;
  the service worker's files, each with its size; what the browser says of this site's storage (its
  use of what the browser allows, and whether the browser has promised to keep it). Written to
  $:/temp/cfworker/device, which the tab shows.
- Ask the browser to keep this site's data: the outbox module makes the call and keeps the answer
  (its status tiddler, which the tab and the cloud icon's dropdown read).
- Forget this device's copy: the device database and the service worker's cache removed, then the
  page reloaded, which brings the wiki back from the worker and fills the copy again, as on a new
  device. Refused while a change or a draft waits in the outbox: it would go with the database.
None of it asks the worker anything. What the buttons answer goes to $:/temp/cfworker/device-message
(field about: keep or forget), shown under the button it answers.
\*/
(function(){

"use strict";

exports.name = "cfworker-device";
exports.platforms = ["browser"];
exports.after = ["cfworker-outbox"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

var MEASURE = "$:/temp/cfworker/device",
	MESSAGE = "$:/temp/cfworker/device-message",
	OUTBOX_STATUS = "$:/temp/cfworker/outbox",   // the outbox's status: what it holds in this tab, whether the worker answers
	DO_MEASURE = "tm-cfworker-device-measure",
	DO_KEEP = "tm-cfworker-device-keep",
	DO_FORGET = "tm-cfworker-device-forget",
	FORGET_WAIT = 5000,   // ms at most for the cache to go, before the reload
	SETTINGS_PATH = "/__cfworker/settings";   // the service worker's own settings, kept in its cache beside the files

exports.startup = function() {
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || Adaptor.prototype.cfworkerDevice || typeof window === "undefined" ||
		typeof Adaptor.prototype.cfworkerDeviceRequest !== "function" || typeof Adaptor.prototype.cfworkerListedTitles !== "function" || typeof Adaptor.prototype.cfworkerOutboxRequest !== "function" || typeof Adaptor.prototype.cfworkerStorageKept !== "function" || typeof Adaptor.prototype.cfworkerForgetDevice !== "function") {
		return;
	}
	if(!lib.onAdminSite(window.location.origin + "/")) {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		origin = window.location.origin;
	proto.cfworkerDevice = true;

	function say(about,text) {
		wiki.addTiddler(new $tw.Tiddler({title: MESSAGE, about: about, text: text}));
	}
	function size(bytes) {
		if(typeof bytes !== "number" || !(bytes >= 0)) {
			return "?";
		}
		if(bytes < 1024) {
			return bytes + " B";
		}
		var units = ["KB","MB","GB","TB"], value = bytes / 1024, i = 0;
		while(value >= 1024 && i < units.length - 1) {
			value /= 1024;
			i++;
		}
		return (value >= 100 ? Math.round(value) : value.toFixed(1)) + " " + units[i];
	}
	function count(n,one,many) {
		return n + " " + (n === 1 ? one : many || one + "s");
	}
	// A file's name as the tab lists it: this site's by path (the page as such), another site's with
	// its host; without the version query
	function fileName(url) {
		var a;
		try {
			a = new URL(url);
		} catch(e) {
			return url;
		}
		var name = a.origin === origin ? a.pathname : a.host + a.pathname;
		if(a.origin === origin && a.pathname === "/") {
			name = "/ (the page)";
		}
		return name;
	}
	// What waits to be sent: the outbox's table (what the device kept, this tab's and the other
	// tabs'), what the outbox module holds in this tab (its status counts a change the device refused
	// to keep, which is in the tab only, design 1.10) and the wiki's drafts (one the device refused
	// the same): the larger count of each, since the table and the tab overlap
	function waitingCounts(entries) {
		var changes = 0, drafts = 0, status = wiki.getTiddler(OUTBOX_STATUS);
		$tw.utils.each(entries || [],function(entry) {
			if(entry.kind === "draft") {
				drafts++;
			} else {
				changes++;
			}
		});
		changes = Math.max(changes,status ? parseInt(status.fields.waiting,10) || 0 : 0);
		drafts = Math.max(drafts,wiki.filterTiddlers("[is[draft]]").length);
		return {changes: changes, drafts: drafts, unkept: !!status && status.fields.kept === "no"};
	}
	function outboxLine(counts) {
		if(!counts.changes && !counts.drafts) {
			return "nothing waiting in the outbox";
		}
		return (counts.changes ? count(counts.changes,"change") : "") + (counts.changes && counts.drafts ? " and " : "") + (counts.drafts ? count(counts.drafts,"draft") : "") + " waiting in the outbox" +
			(counts.unkept ? " (some of it the device refused to keep: it lives in this tab until it's sent)" : "");
	}

	// --- Measure --------------------------------------------------------------------------------------

	function isSettingsEntry(url) {
		var a;
		try {
			a = new URL(url);
		} catch(e) {
			return false;
		}
		return a.origin === origin && a.pathname === SETTINGS_PATH;
	}
	function cacheFiles() {
		if(typeof caches !== "object") {
			return Promise.resolve(null);
		}
		return caches.open(lib.SW_CACHE).then(function(cache) {
			return cache.keys().then(function(requests) {
				return Promise.all(requests.filter(function(request) {
					return !isSettingsEntry(request.url);   // (not a file: the service worker's settings)
				}).map(function(request) {
					return cache.match(request).then(function(response) {
						return response ? response.blob().then(function(blob) {
							return {name: fileName(request.url), size: blob.size};
						}) : {name: fileName(request.url), size: 0};
					}).catch(function() {
						return {name: fileName(request.url), size: 0};
					});
				}));
			});
		}).catch(function() {
			return null;
		});
	}
	function browserSays() {
		var api = typeof navigator === "object" && navigator.storage,
			estimate = api && typeof api.estimate === "function" ? api.estimate().catch(function() { return null; }) : Promise.resolve(null);
		return Promise.all([estimate,proto.cfworkerStorageKept(false)]).then(function(results) {
			return {estimate: results[0], kept: results[1]};
		});
	}
	function measure() {
		wiki.addTiddler(new $tw.Tiddler({title: MEASURE, text: "Measuring…"}));
		Promise.all([
			proto.cfworkerDeviceRequest("readonly",function(store) { return store.getAll(); }),
			proto.cfworkerOutboxRequest("readonly",function(store) { return store.getAll(); }),
			cacheFiles(),
			browserSays()
		]).then(function(results) {
			var copy = results[0], outbox = results[1], files = results[2], browser = results[3],
				lines = [];
			if(copy) {
				// Of the tiddlers listed and not kept: the ones the page itself carries (the site title,
				// the default tiddlers, the settings: baked in by the worker, in full, so TiddlyWiki never
				// loads them and the copy never sees them; offline they come with the page), and the ones
				// not loaded yet (the fill off, or still running)
				var kept = Object.create(null), inPage = 0, notYet = 0, listed = proto.cfworkerListedTitles();
				$tw.utils.each(copy,function(entry) {
					kept[entry.title] = true;
				});
				$tw.utils.each(listed,function(title) {
					if(kept[title]) {
						return;
					}
					var tiddler = wiki.getTiddler(title);
					if(tiddler && !tiddler.hasField("_is_skinny")) {
						inPage++;
					} else {
						notYet++;
					}
				});
				lines.push("''This device:'' " + copy.length + " of " + listed.length + " tiddlers kept (" + size(lib.utf8Length(JSON.stringify(copy))) + ")" +
					(inPage || notYet ? " — " + [inPage ? count(inPage,"tiddler") + " in the page itself" : "", notYet ? count(notYet,"tiddler") + " not loaded yet" : ""].filter(Boolean).join(", ") : "") +
					"; " + outboxLine(waitingCounts(outbox)) + ".");
			} else {
				lines.push("''This device:'' no device copy (the browser gave no database: nothing is kept here, and a change made offline isn't either).");
			}
			if(files) {
				var total = 0;
				files.sort(function(a,b) { return b.size - a.size; });
				$tw.utils.each(files,function(file) { total += file.size; });
				lines.push("", "''The service worker's files'' (" + count(files.length,"file") + ", " + size(total) + "):", "");
				$tw.utils.each(files,function(file) {
					lines.push("* <$text text=" + JSON.stringify(file.name) + "/> (" + size(file.size) + ")");
				});
				if(!files.length) {
					lines.push("* none yet: reload the page once, online");
				}
			} else {
				lines.push("", "''The service worker's files:'' this browser has no cache storage here (nothing kept for opening offline).");
			}
			var estimate = browser.estimate, details = estimate && estimate.usageDetails, parts = [];
			if(details) {
				$tw.utils.each({indexedDB: "the device copy and the outbox", caches: "the service worker's files"},function(label,key) {
					if(typeof details[key] === "number") {
						parts.push(label + " " + size(details[key]));
					}
				});
			}
			lines.push("", "''The browser:'' " + (estimate && typeof estimate.usage === "number" && typeof estimate.quota === "number" ?
				"this site uses " + size(estimate.usage) + " of the " + size(estimate.quota) + " it allows" + (parts.length ? " (" + parts.join(", ") + ")" : "") :
				"it doesn't say how much this site uses or may use") + "; it " + (browser.kept === true ? "has promised to keep it." : browser.kept === false ? "hasn't promised to keep it (ask it below)." : "doesn't say whether it will keep it."));
			lines.push("", "Measured at <$view tiddler='" + MEASURE + "' field='measured' format='date' template='0hh:0mm:0ss'/>.");
			wiki.addTiddler(new $tw.Tiddler({title: MEASURE, text: lines.join("\n"), measured: $tw.utils.stringifyDate(new Date())}));
		}).catch(function(e) {
			// (Each source answers null when it fails; this is for anything else, rather than "Measuring…" for good)
			wiki.addTiddler(new $tw.Tiddler({title: MEASURE, text: "Couldn't measure: <$text text=\"\"\"" + String(e && e.message || e).replace(/"""/g,"'") + "\"\"\"/>", measured: $tw.utils.stringifyDate(new Date())}));
		});
	}
	$tw.rootWidget.addEventListener(DO_MEASURE,function() {
		measure();
		return false;
	});

	// --- Ask the browser to keep this site's data ------------------------------------------------------

	$tw.rootWidget.addEventListener(DO_KEEP,function() {
		say("keep","Asking…");
		proto.cfworkerStorageKept(true).then(function(granted) {
			say("keep",granted === true ? "The browser has promised to keep this site's data." :
				granted === false ? "The browser didn't promise: it decides by its own rules (Chrome: a site used often, installed, or bookmarked; Firefox: your answer to its question). Ask again later, or install the wiki as an app." :
				"This browser can't be asked (it has no such promise to make).");
		});
		return false;
	});

	// --- Forget this device's copy ---------------------------------------------------------------------

	function deleteCaches() {
		if(typeof caches !== "object") {
			return Promise.resolve();
		}
		var gone = caches.keys().then(function(names) {
			return Promise.all(names.filter(function(name) {
				return name.indexOf("cfworker-wiki-") === 0;
			}).map(function(name) {
				return caches["delete"](name);
			}));
		}).catch(function() {});
		return Promise.race([gone,new Promise(function(resolve) { setTimeout(resolve,FORGET_WAIT); })]);
	}
	$tw.rootWidget.addEventListener(DO_FORGET,function() {
		proto.cfworkerOutboxRequest("readonly",function(store) { return store.getAll(); }).then(function(entries) {
			var counts = waitingCounts(entries);
			if(counts.changes || counts.drafts) {
				say("forget","Not now: " + outboxLine(counts) + ", and it would go with the copy. A change is sent at the network's return (one the alert asks to rename, once renamed); a draft, save or cancel it. Then forget.");
				return;
			}
			// (The page reloads once the copy is gone, from the worker: with no network there'd be
			// nothing to reload from, the copy and the files already gone. The browser's own flag says
			// online whenever an interface is up; the outbox's status knows a request that got no answer)
			var outboxStatus = wiki.getTiddler(OUTBOX_STATUS),
				browserOffline = typeof navigator === "object" && navigator.onLine === false,
				workerSilent = !!outboxStatus && outboxStatus.fields.online === "no";
			if(browserOffline || workerSilent) {
				say("forget","Not now: " + (browserOffline ? "this browser is offline" : "the worker isn't answering (no network, or it can't be reached)") + ", and the page comes back from the worker once the copy is gone. Get back online first, then forget.");
				return;
			}
			say("forget","Forgetting…");
			return proto.cfworkerForgetDevice().then(function(removed) {
				// (true: gone, or going as the last connection closes; null: there was no database; false:
				// the browser refused to remove it, so nothing is removed and the page stays)
				if(removed === false) {
					say("forget","Not done: the browser refused to remove the device copy's database. Nothing was removed; try again, or clear this site's data from the browser's settings.");
					return;
				}
				return deleteCaches().then(function() {
					window.location.reload();
				});
			});
		});
		return false;
	});
};

})();
