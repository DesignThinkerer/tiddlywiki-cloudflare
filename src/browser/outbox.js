/*\
title: $:/cfworker/outbox.js
type: application/javascript
module-type: startup

The outbox (design 1.10): every change made in this tab is kept on the device the moment it's made,
until the worker has it, so that editing offline loses nothing. TiddlyWiki itself retries a save
that failed, every few seconds, and sends everything once the network is back; this adds:
- A save or a delete is written to the outbox table of the device database (the list sync's,
  $:/cfworker/list-sync.js) at the change, with the server revision it was made from, and removed
  once the worker confirms it. A draft is kept there too, never sent to the worker (design 2.7),
  until it's saved or cancelled.
- At the next page load on this device, once the first tiddler list is in, what's still in the
  outbox is put back into the wiki: TiddlyWiki then saves or deletes it as it would have, and the
  conflict guard bases that on the revision the change was made from (cfworkerBaseFor), so a version
  saved elsewhere meanwhile is a conflict, with a copy, as it would have been. A draft comes back as
  a draft, which TiddlyWiki lists at the top of the page. Not what another open tab of this browser
  still holds (the outbox is shared by its tabs): the loading tab asks over a BroadcastChannel and
  leaves those to their tab, which sends them itself.
- The network's return (the browser's online event) wakes the syncer at once, rather than at its
  next retry.
- $:/temp/cfworker/outbox says how many changes wait (waiting), since when (since) and whether the
  browser is online (online); an item in the dropdown of TiddlyWeb's cloud icon (the "Server
  status" button, red while something is unsaved) shows that while something waits. TiddlyWiki's
  own "Network Error" alert isn't shown on the admin site: the icon and the dropdown say it, and
  the alert would be back at every retry (design 2.17). Its other alerts show as they do.
\*/
(function(){

"use strict";

exports.name = "cfworker-outbox";
exports.platforms = ["browser"];
exports.after = ["cfworker-list-sync","cfworker-conflict-guard"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

var STATUS = "$:/temp/cfworker/outbox",
	ITEM = "$:/temp/cfworker/outbox-status",
	DRAFT_PAUSE = 300,   // ms of typing before a draft is written to the device ($:/config/cfworker/DraftPause, the plugin's settings)
	KNOWN_WAIT = 100,    // ms between looks for a tiddler the syncer is about to know (a delete put back)
	KNOWN_TRIES = 100,
	ASK_WAIT = 300;      // ms a tab waits for the other tabs to say what they hold, before putting back

// In the cloud icon's dropdown ($:/tags/SyncerDropdown), under "You are logged in": what waits
var ITEM_TEXT = [
	"<$list filter='[[" + STATUS + "]get[waiting]!match[0]]' variable='n'>",
	"<div class='tc-drop-down-info'>",
	"<$text text={{{ [[" + STATUS + "]get[waiting]] }}}/> <$text text={{{ [[" + STATUS + "]get[waiting]compare:number:eq[1]then[change]else[changes]] }}}/> waiting since <$view tiddler='" + STATUS + "' field='since' format='date' template='0hh:0mm'/><br/>",
	"<$list filter='[[" + STATUS + "]get[online]match[no]]' variable='off'>offline: kept on this device until sent</$list>",
	"<$list filter='[[" + STATUS + "]get[online]match[yes]]' variable='on'>sending (kept on this device until then)</$list>",
	"<$list filter='[[" + STATUS + "]get[storage]match[best-effort]]' variable='risk'><br/>''This browser hasn't promised to keep the device's copy'' (it may clear it when short of space): get back online soon, or <$link to='$:/plugins/cfworker/admin/device'>ask it to keep this site's data</$link>.</$list>",
	"</div>",
	"<hr/>",
	"</$list>"
].join("\n");

exports.startup = function() {
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || Adaptor.prototype.cfworkerOutbox || typeof window === "undefined" || typeof Adaptor.prototype.cfworkerOutboxRequest !== "function" || typeof Adaptor.prototype.cfworkerBaseFor !== "function") {
		return;
	}
	// Only on the admin site: the public one is read-only
	if(!lib.onAdminSite(window.location.origin + "/")) {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		entries = Object.create(null),   // title -> {title, kind: save | delete | draft, fields, base, count, time}
		fromDevice = null,               // what the device's outbox held at this page load, until put back
		firstList = null,                // the first tiddler list of this page load, title -> revision
		online = typeof navigator !== "object" || navigator.onLine !== false,
		storage = "",                    // "persistent" once the browser has promised to keep this site's storage, "best-effort" if it won't
		draftTimers = Object.create(null),
		statusTimer = null;
	proto.cfworkerOutbox = true;

	function request(mode,work) {
		return proto.cfworkerOutboxRequest(mode,work);
	}
	function keep(entry) {
		entries[entry.title] = entry;
		request("readwrite",function(store) {
			return store.put(entry);
		});
		updateStatus();
	}
	function forget(title) {
		if(!entries[title]) {
			return;
		}
		delete entries[title];
		request("readwrite",function(store) {
			return store["delete"](title);
		});
		updateStatus();
	}
	function isSynced(title) {
		var s = $tw.syncer;
		return !!s && s.getSyncedTiddlers([title]).length > 0;
	}

	// --- The status, and the item in the cloud icon's dropdown ---------------------------------------

	function updateStatus() {
		if(statusTimer) {
			return;
		}
		statusTimer = setTimeout(function() {
			statusTimer = null;
			var waiting = 0,
				since = null;
			$tw.utils.each(entries,function(entry) {
				if(entry.kind !== "draft") {
					waiting++;
					if(since === null || entry.time < since) {
						since = entry.time;
					}
				}
			});
			var fields = {title: STATUS, waiting: String(waiting), online: online ? "yes" : "no"},
				current = wiki.getTiddler(STATUS);
			if(since !== null) {
				fields.since = $tw.utils.stringifyDate(new Date(since));
			}
			if(storage) {
				fields.storage = storage;
			}
			if(!current || current.fields.waiting !== fields.waiting || current.fields.online !== fields.online || current.fields.since !== fields.since || current.fields.storage !== fields.storage) {
				wiki.addTiddler(new $tw.Tiddler(fields));
			}
		},0);
	}
	function setOnline(value) {
		if(online !== value) {
			online = value;
			updateStatus();
		}
	}
	// What a save or delete answered: the network gone, or back
	function noteNetwork(err) {
		if(!err) {
			setOnline(true);
		} else if(err === $tw.language.getString("Error/XMLHttpRequest") + ": 0") {
			setOnline(false);
		}
	}
	wiki.addTiddler(new $tw.Tiddler({title: ITEM, tags: ["$:/tags/SyncerDropdown"], "list-after": "$:/plugins/tiddlywiki/tiddlyweb/syncer-actions/login-status", text: ITEM_TEXT}));
	updateStatus();

	// Whether the browser has promised to keep this site's storage (the outbox, the device copy, the
	// service worker's cache) rather than clear it when short of space: storage under pressure is
	// evicted whole, and a change waiting in the outbox would go with it. Asked (persist()) only on
	// a click in the device tab ($:/cfworker/device.js), never at page load: Firefox puts the question
	// to the user, which at every load was a prompt at every load; Chrome and Safari answer by their
	// own rules (a site used often, installed, or bookmarked). At load, only what was promised so far
	// (persisted(), no question asked); the status says, and the dropdown while a change waits.
	proto.cfworkerStorageKept = function(ask) {
		var api = typeof navigator === "object" && navigator.storage,
			call = api && (ask ? api.persist : api.persisted);
		if(typeof call !== "function") {
			return Promise.resolve(null);
		}
		return call.call(api).then(function(granted) {
			storage = granted ? "persistent" : "best-effort";
			updateStatus();
			return !!granted;
		},function() {
			return null;
		});
	};
	proto.cfworkerStorageKept(false);

	window.addEventListener("online",function() {
		setOnline(true);
		if($tw.syncer) {
			$tw.syncer.processTaskQueue();
		}
	});
	window.addEventListener("offline",function() {
		setOnline(false);
	});

	// --- TiddlyWiki's network alert: not shown here ---------------------------------------------------

	// The syncer shows its "Network Error" alert at every request that fails with a network error
	// (status 0), so it comes back at every retry, every few seconds, and asks to be closed each time.
	// On the admin site the red cloud icon and the dropdown's item say the same, and more (what
	// waits, that it's kept on this device): the alert is logged instead, and the browser marked
	// offline, a failed load or list included. TiddlyWiki's other alerts (a save refused by the
	// worker, say) show as they do.
	var originalDisplayError = $tw.Syncer.prototype.displayError;
	$tw.Syncer.prototype.displayError = function(msg,err) {
		if(err === $tw.language.getString("Error/XMLHttpRequest") + ": 0") {
			setOnline(false);
			this.logger.log(msg + ":",err);
			return;
		}
		return originalDisplayError.apply(this,arguments);
	};

	// --- Every change, kept at once --------------------------------------------------------------------

	wiki.addEventListener("change",function(changes) {
		var s = $tw.syncer,
			now = Date.now();
		if(!s) {
			return;   // (before the syncer exists: the page's own boot)
		}
		$tw.utils.each(changes,function(change,title) {
			if(title.indexOf("$:/temp/") === 0 || title.indexOf("$:/state/") === 0) {
				return;
			}
			var tiddler = !change.deleted && wiki.getTiddler(title),
				existing = entries[title],
				info = s.tiddlerInfo[title];
			if(tiddler && tiddler.hasField("draft.of")) {
				// A draft, as it is now, a moment after the typing
				if(draftTimers[title]) {
					clearTimeout(draftTimers[title]);
				}
				draftTimers[title] = setTimeout(function() {
					delete draftTimers[title];
					var draft = wiki.getTiddler(title);
					if(draft && draft.hasField("draft.of")) {
						keep({title: title, kind: "draft", fields: draft.getFieldStrings(), time: existing && existing.kind === "draft" ? existing.time : now});
					}
				},parseInt(wiki.getTiddlerText("$:/config/cfworker/DraftPause",""),10) || DRAFT_PAUSE);
				return;
			}
			if(change.deleted) {
				if(draftTimers[title]) {
					clearTimeout(draftTimers[title]);
					delete draftTimers[title];
				}
				if(info) {
					// Known to the worker: to delete there, from the version this run of changes
					// started from (a delete put back from the device keeps its own)
					var base = existing && existing.kind !== "draft" && typeof existing.base === "string" ? existing.base : String(info.revision);
					keep({title: title, kind: "delete", base: base, time: existing && existing.kind !== "draft" ? existing.time : now});
				} else {
					// A draft saved or cancelled, or a tiddler made and deleted before the worker saw it
					forget(title);
				}
				return;
			}
			if(!tiddler) {
				return;
			}
			var count = wiki.getChangeCount(title);
			if(info && count <= info.changeCount) {
				return;   // the worker's own version, loaded or just saved: nothing waits
			}
			if(!isSynced(title)) {
				return;
			}
			keep({
				title: title, kind: "save", fields: tiddler.getFieldStrings(), count: count,
				// The server revision this run of changes started from, kept through later changes
				base: existing && existing.kind === "save" ? existing.base : (info ? String(info.revision) : null),
				time: existing && existing.kind !== "draft" ? existing.time : now
			});
		});
	});

	// --- Confirmed by the worker: out of the outbox -------------------------------------------------

	// Whether this tab's copy of a tiddler is the worker's version, as far as the syncer knows (just
	// loaded, saved, or put back by the conflict guard)
	function clean(title) {
		var s = $tw.syncer,
			info = s && s.tiddlerInfo[title];
		return !!info && wiki.tiddlerExists(title) && wiki.getChangeCount(title) <= info.changeCount;
	}
	// A save or delete answered: out of the outbox once the worker has it, or once the conflict guard
	// has settled it (the worker's version adopted here, this tab's kept as a copy: that copy waits
	// in its own right); a change made since the save was sent still waits
	function settled(title,kind,err,count) {
		var entry = entries[title];
		if(!entry || entry.kind !== kind) {
			return;
		}
		if((!err && (kind === "delete" || entry.count <= count)) || clean(title)) {
			forget(title);
		}
	}
	var originalSaveTiddler = proto.saveTiddler,
		originalDeleteTiddler = proto.deleteTiddler;
	proto.saveTiddler = function(tiddler,callback,options) {
		var title = tiddler.fields.title,
			count = wiki.getChangeCount(title);
		return originalSaveTiddler.call(this,tiddler,function(err) {
			noteNetwork(err);
			settled(title,"save",err,count);
			return callback.apply(this,arguments);
		},options);
	};
	proto.deleteTiddler = function(title,callback,options) {
		return originalDeleteTiddler.call(this,title,function(err) {
			noteNetwork(err);
			settled(title,"delete",err);
			return callback.apply(this,arguments);
		},options);
	};

	// --- Put back at the next page load ----------------------------------------------------------------

	// Once the syncer knows the tiddler from the list (it stores the skinny version right after the
	// list's listeners), or gives up
	function whenKnown(title,then,tries) {
		var s = $tw.syncer;
		if(s && s.tiddlerInfo[title]) {
			return then(true);
		}
		if((tries || 0) >= KNOWN_TRIES) {
			return then(false);
		}
		setTimeout(function() {
			whenKnown(title,then,(tries || 0) + 1);
		},KNOWN_WAIT);
	}
	// The other tabs of this browser share the device's outbox: one asks what they hold before putting
	// anything back, so a draft being typed, or a change a tab is still sending, stays with that tab.
	// A tab that can't answer (frozen in the background, say) is taken for gone, as before.
	var channel = null,
		asking = null;
	try {
		channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("cfworker-outbox:" + window.location.pathname) : null;
	} catch(e) {
		channel = null;
	}
	if(channel) {
		channel.onmessage = function(event) {
			var data = event.data || {};
			if(data.ask) {
				var titles = Object.keys(entries);
				if(titles.length) {
					channel.postMessage({held: data.ask, titles: titles});
				}
			} else if(data.held && asking && data.held === asking.id) {
				$tw.utils.each(data.titles,function(title) {
					asking.held[title] = true;
				});
			}
		};
	}
	function askOthers(then) {
		if(!channel) {
			return then(Object.create(null));
		}
		asking = {id: String(Date.now()) + Math.random(), held: Object.create(null)};
		channel.postMessage({ask: asking.id});
		setTimeout(function() {
			var held = asking.held;
			asking = null;
			then(held);
		},ASK_WAIT);
	}

	function putBack() {
		var fromOutbox = fromDevice,
			listed = firstList;
		if(!fromOutbox || !listed) {
			return;
		}
		fromDevice = null;
		askOthers(function(heldElsewhere) {
			$tw.utils.each(fromOutbox,function(entry) {
				if(!heldElsewhere[entry.title]) {
					putBackEntry(entry,listed);
				}
			});
			updateStatus();
		});
	}
	function putBackEntry(entry,listed) {
		var title = entry.title;
		if(entry.kind === "draft") {
			// (Unless this tab already has a draft of that name: the one being typed wins)
			if(!wiki.tiddlerExists(title)) {
				entries[title] = entry;
				wiki.addTiddler(new $tw.Tiddler(entry.fields));
			}
		} else if(entry.kind === "save") {
			entries[title] = entry;
			proto.cfworkerBaseFor(title,entry.base);
			wiki.addTiddler(new $tw.Tiddler(entry.fields));
			entry.count = wiki.getChangeCount(title);
		} else if(entry.kind === "delete") {
			if(!$tw.utils.hop(listed,title)) {
				// Gone from the worker since: nothing left to delete
				request("readwrite",function(store) {
					return store["delete"](title);
				});
				return;
			}
			entries[title] = entry;
			whenKnown(title,function(known) {
				if(!known || !entries[title]) {
					return forget(title);
				}
				proto.cfworkerBaseFor(title,entry.base);
				if(proto.cfworkerDropLoad) {
					proto.cfworkerDropLoad(title);
				}
				wiki.deleteTiddler(title);
			});
		}
	}
	proto.cfworkerOnList(function(listed,previous) {
		if(previous === null) {
			firstList = listed;
			putBack();
		}
	});
	request("readonly",function(store) {
		return store.getAll();
	}).then(function(list) {
		fromDevice = list || [];
		putBack();
	});
};

})();
