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
- A tiddler whose title the worker can't store (list-sync.js keeps it out of syncing and asks to
  rename it) is kept too, never sent, so a reload doesn't lose it; the browser asks before the tab
  closes, as for any unsaved change. Renamed, the old title leaves with the delete the rename makes.
- $:/temp/cfworker/outbox says how many changes wait (waiting), how many of them for a rename
  (rename), since when (since), whether the worker answers (online: the browser's events, a save
  answered or not, a list from the worker or from the service worker's cache), whether the Access login
  stands (login: "expired" once it doesn't) and whether the device took them (kept: "no" when a
  write failed); an item in the dropdown of TiddlyWeb's cloud icon (the "Server status" button, red
  while something is unsaved) shows that while something waits, or while the login has expired.
  TiddlyWiki's own "Network Error" alert isn't shown on the admin site: the icon and the dropdown
  say it, and the alert would be back at every retry (design 2.17). Its other alerts show as they do.
- The tabs of this browser follow each other over the same channel (design 1.16, 2.27): a change is
  handed to the other tabs the moment it's made, online or not, which show it as the version this tab
  will save; the worker's revision follows once the save is confirmed, and they store it as the list
  sync does after a save of their own, no request made; a draft is one per tiddler for the
  browser, sent as its fields at each change, shown live in every tab that has it open, and closed
  everywhere when one tab saves or cancels it. Nothing of it reaches the worker.
- An expired Access session is told from a lost network (design 2.26): both end a request with no
  answer (Access redirects to its login page, on another origin, which the browser blocks). After
  such a failure, or a tiddler list the service worker answered from its cache, while the browser
  says it's online, the tab asks Access's own identity path once (answered at the edge, never a
  worker request): the identity while the session stands, an error once it's gone. The dropdown
  then says the login has expired and how to log in again, not "offline"; the first request that
  goes through, or the first real list, clears it.
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
	ASK_WAIT = 300,      // ms a tab waits for the other tabs to say what they hold, before putting back
	DROPPED_GRACE = 1000,   // ms after a draft is saved or cancelled here during which another tab's copy of it, crossing that, is ignored
	STORY = "$:/StoryList",
	IDENTITY = "/cdn-cgi/access/get-identity";   // Access's own path on the admin site: the session's identity, answered at the edge

// In the cloud icon's dropdown ($:/tags/SyncerDropdown), under "You are logged in": what waits, and
// the login once it has expired (shown then with nothing waiting too: a tab that only reads is the
// one that would never learn it's cut off). The link opens the admin site in a new tab, which Access
// meets with its login page; logged in there, this tab's own retries go through.
var LOGIN_LINK = "<a class='tc-tiddlylink-external' href='/' target='_blank' rel='noopener noreferrer'>Log in again</a>";
var ITEM_TEXT = [
	"<$list filter='[[" + STATUS + "]get[waiting]!match[0]] [[" + STATUS + "]get[login]match[expired]] +[limit[1]]' variable='show'>",
	"<div class='tc-drop-down-info'>",
	"<$list filter='[[" + STATUS + "]get[waiting]!match[0]]' variable='n'>",
	"<$text text={{{ [[" + STATUS + "]get[waiting]] }}}/> <$text text={{{ [[" + STATUS + "]get[waiting]compare:number:eq[1]then[change]else[changes]] }}}/> waiting since <$view tiddler='" + STATUS + "' field='since' format='date' template='0hh:0mm'/><br/>",
	"<$list filter='[[" + STATUS + "]get[login]match[expired]]' variable='expired'><$list filter='[[" + STATUS + "]get[kept]!match[no]]' variable='kept'>''your login has expired'': kept on this device until you log in again</$list><$list filter='[[" + STATUS + "]get[kept]match[no]]' variable='unkept'>''your login has expired'', and ''not kept on this device'': the browser refused to store it (no room left, or storage off here). Keep this tab open and log in again.</$list></$list>",
	"<$list filter='[[" + STATUS + "]get[login]!match[expired]]' variable='loggedin'>",
	"<$list filter='[[" + STATUS + "]get[online]match[no]]' variable='off'><$list filter='[[" + STATUS + "]get[kept]!match[no]]' variable='kept'>offline: kept on this device until sent</$list><$list filter='[[" + STATUS + "]get[kept]match[no]]' variable='unkept'>offline, and ''not kept on this device'': the browser refused to store it (no room left, or storage off here). Keep this tab open until the network is back.</$list></$list>",
	"<$list filter='[[" + STATUS + "]get[online]match[yes]]' variable='on'><$list filter='[[" + STATUS + "]get[kept]!match[no]]' variable='kept'>sending (kept on this device until then)</$list><$list filter='[[" + STATUS + "]get[kept]match[no]]' variable='unkept'>sending — ''not kept on this device'' (the browser refused to store it): keep this tab open until it's sent.</$list></$list>",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[rename]!match[0]]' variable='r'><br/><$text text={{{ [[" + STATUS + "]get[rename]] }}}/> to rename before <$text text={{{ [[" + STATUS + "]get[rename]compare:number:eq[1]then[it]else[they]] }}}/> can be sent (an alert says which).</$list>",
	"<$list filter='[[" + STATUS + "]get[storage]match[best-effort]]' variable='risk'><br/>''This browser hasn't promised to keep the device's copy'' (it may clear it when short of space): get back online soon, or <$link to='$:/plugins/cfworker/admin/device'>ask it to keep this site's data</$link>.</$list>",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[login]match[expired]]' variable='expired'>",
	"<$list filter='[[" + STATUS + "]get[waiting]match[0]]' variable='nothing'>''Your login has expired'': changes made on other devices no longer reach this tab, and one made here would wait on this device.</$list>",
	"<br/>" + LOGIN_LINK + " (a new tab; this one then sends what waits by itself), or reload this page: what waits is kept on this device through it.",
	"</$list>",
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
		firstListFromCache = false,      // ...the service worker's copy, the network gone: a title it lacks isn't known gone
		deferred = [],                   // deletes put back once a real list says whether their tiddler is still there
		online = typeof navigator !== "object" || navigator.onLine !== false,
		login = "ok",                    // "expired" once Access says the session is gone, until a request goes through
		probing = null,                  // the question to Access in flight (its promise), or null
		received = Object.create(null),  // draft title -> the tiddler last applied from another tab (its own change event is no news)
		drafts = Object.create(null),    // draft title -> {of, to}: the drafts this tab has, by what they're of and the title they save to
		dropping = Object.create(null),  // draft titles being deleted here on another tab's word
		justDropped = Object.create(null),   // draft title -> when it was saved or cancelled here
		storage = "",                    // "persistent" once the browser has promised to keep this site's storage, "best-effort" if it won't
		draftTimers = Object.create(null),
		statusTimer = null;
	proto.cfworkerOutbox = true;

	function request(mode,work) {
		return proto.cfworkerOutboxRequest(mode,work);
	}
	// (The write's result is looked at: null is no database, or a write the browser refused — a full
	// quota, say — and the status then says the change isn't kept on this device, rather than that
	// it is; the change still goes at the network's return, from this tab, while it's open)
	function keep(entry) {
		entries[entry.title] = entry;
		request("readwrite",function(store) {
			return store.put(entry);
		}).then(function(result) {
			var kept = result !== null;
			if(entry.kept !== kept && entries[entry.title] === entry) {
				entry.kept = kept;
				updateStatus();
			}
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
	// A title the worker can't store (storableTitle) is kept out of syncing by the list sync, which
	// asks to rename it; it's kept here all the same, never sent, so a reload doesn't lose it:
	// TiddlyWiki's own rule says whether it would sync (the syncer's filter, before the exclusions)
	function isKept(title) {
		var s = $tw.syncer;
		if(!s) {
			return false;
		}
		return lib.storableTitle(title) ? isSynced(title) : s.filterFn.call(wiki,[title]).length > 0;
	}
	// How many wait for a rename
	function toRename() {
		var n = 0;
		$tw.utils.each(entries,function(entry) {
			if(entry.kind === "save" && !lib.storableTitle(entry.title)) {
				n++;
			}
		});
		return n;
	}

	// --- The status, and the item in the cloud icon's dropdown ---------------------------------------

	function updateStatus() {
		if(statusTimer) {
			return;
		}
		statusTimer = setTimeout(function() {
			statusTimer = null;
			var waiting = 0,
				since = null,
				unkept = false;
			$tw.utils.each(entries,function(entry) {
				if(entry.kept === false) {
					unkept = true;
				}
				if(entry.kind !== "draft") {
					waiting++;
					if(since === null || entry.time < since) {
						since = entry.time;
					}
				}
			});
			var fields = {title: STATUS, waiting: String(waiting), rename: String(toRename()), online: online ? "yes" : "no", login: login, kept: unkept ? "no" : "yes"},
				current = wiki.getTiddler(STATUS);
			if(since !== null) {
				fields.since = $tw.utils.stringifyDate(new Date(since));
			}
			if(storage) {
				fields.storage = storage;
			}
			if(!current || current.fields.waiting !== fields.waiting || current.fields.online !== fields.online || current.fields.login !== fields.login || current.fields.since !== fields.since || current.fields.storage !== fields.storage || current.fields.kept !== fields.kept || current.fields.rename !== fields.rename) {
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
	function setLogin(value) {
		if(login !== value) {
			login = value;
			updateStatus();
		}
	}
	// Whether Access's answer to its identity path says the session is gone: an error of its own (400
	// "no app token set" on a real application; 401 and 403 for good measure), or a redirect to its
	// login page (the fetch doesn't follow it, so it shows as one). The identity itself (ok) says it
	// stands; anything else (a 404 from a worker with no Access in front, say) says nothing about it.
	function sessionGone(response) {
		return response.type === "opaqueredirect" || response.status === 400 || response.status === 401 || response.status === 403;
	}
	// A request ended with no answer, or the list came from the service worker's cache, while the
	// browser says it's online: the network gone, or the session? Access's own path tells (design
	// 2.26): answered at the edge, never a worker request, and not a path the service worker handles.
	// Asked once per such stretch, never while the login is known to have expired; the first request
	// that goes through, or the first real list, clears it. Resolves with the login state once known.
	function probe() {
		if(probing) {
			return probing;
		}
		if(login === "expired" || typeof fetch !== "function" || (typeof navigator === "object" && navigator.onLine === false)) {
			return Promise.resolve(login);
		}
		probing = fetch(IDENTITY,{redirect: "manual", credentials: "same-origin", cache: "no-store"}).then(function(response) {
			probing = null;
			if(sessionGone(response)) {
				setLogin("expired");
				setOnline(true);   // (the network answered)
			}
			// (The session stands: the failure was the worker's or the network's, which "offline" says)
			return login;
		},function() {
			probing = null;
			setOnline(false);   // nothing answered: the network is gone
			return login;
		});
		return probing;
	}
	// A request ended with no answer (status 0): offline, as it looks, until Access says otherwise;
	// nothing new while the login is known to have expired (every retry ends that way)
	function noteNoAnswer() {
		if(login !== "expired") {
			setOnline(false);
		}
		return probe();
	}
	// Once a save is answered, the syncer (or, for a refused one, the conflict guard, which stores the
	// worker's version here) holds what the worker has: that version travels to the other tabs with the
	// worker's revision, if this tab's copy is that version (nothing changed it since: a change made
	// meanwhile travels with its own save) and it isn't a skinny one (the worker kept the stored text,
	// which this tab doesn't have). The others then hold the worker's revision too, or stop showing a
	// version the worker refused (design 1.16, 2.27).
	function tellHeld(title) {
		var s = $tw.syncer,
			info = s && s.tiddlerInfo[title],
			held = wiki.getTiddler(title);
		if(!info || !held || info.revision === undefined || info.revision === null || wiki.getChangeCount(title) !== info.changeCount || held.hasField("_is_skinny")) {
			return;
		}
		tell({saved: {title: title, revision: String(info.revision), fields: held.getFieldStrings()}});
	}
	// For another module whose own request ended with no answer (the setup check, control-panel.js):
	// taken as a failed save is, and resolved with the login state ("ok" or "expired") once Access
	// has been asked, so the module can say which it was
	proto.cfworkerNoAnswer = function() {
		return noteNoAnswer();
	};
	// What a save or delete answered: the network gone, or back, and the login standing
	function noteNetwork(err) {
		if(!err) {
			setOnline(true);
			setLogin("ok");
		} else if(err === $tw.language.getString("Error/XMLHttpRequest") + ": 0") {
			noteNoAnswer();
		}
	}
	wiki.addTiddler(new $tw.Tiddler({title: ITEM, tags: ["$:/tags/SyncerDropdown"], "list-after": "$:/plugins/tiddlywiki/tiddlyweb/syncer-actions/login-status", text: ITEM_TEXT}));
	updateStatus();

	// Whether the browser has promised to keep this site's storage (the outbox, the device copy, the
	// service worker's cache) rather than clear it when short of space: storage under pressure is
	// evicted whole, and a change waiting in the outbox would go with it. Asked (persist()) only on
	// a click in the device tab ($:/cfworker/device.js), never at page load: Firefox puts the question
	// to the user, so asking at every load was a prompt at every load; Chrome and Safari answer by
	// their own rules (a site used often, installed, or bookmarked). At load, only what was promised so far
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

	// A tiddler whose title the worker can't store waits here until it's renamed, never sent, and
	// the syncer doesn't count it as unsaved (it's out of syncing): the browser asks before closing
	// or reloading the tab, as TiddlyWiki does for any unsaved change
	window.addEventListener("beforeunload",function(event) {
		if(toRename() > 0) {
			var message = $tw.language.getString("UnsavedChangesWarning");
			event.preventDefault();
			event.returnValue = message;
			return message;
		}
	});

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
	// offline, a failed load or list included, or the login expired once Access has been asked
	// (noteNoAnswer). TiddlyWiki's other alerts (a save refused by the worker, say) show as they do.
	var originalDisplayError = $tw.Syncer.prototype.displayError;
	$tw.Syncer.prototype.displayError = function(msg,err) {
		if(err === $tw.language.getString("Error/XMLHttpRequest") + ": 0") {
			noteNoAnswer();
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
				drafts[title] = {of: tiddler.fields["draft.of"], to: tiddler.fields["draft.title"] || tiddler.fields["draft.of"]};
				delete justDropped[title];
				// Another tab's typing, applied here (takeDraft): no news for the others, and that tab
				// keeps it on the device
				if(received[title] && tiddler.isEqual(received[title])) {
					return;
				}
				delete received[title];
				tell(withBase({draft: {title: title, fields: tiddler.getFieldStrings()}},title));
				// A draft, as it is now, a moment after the typing
				if(draftTimers[title]) {
					clearTimeout(draftTimers[title]);
				}
				draftTimers[title] = setTimeout(function() {
					delete draftTimers[title];
					var draft = wiki.getTiddler(title);
					if(draft && draft.hasField("draft.of")) {
						keep(withBase({title: title, kind: "draft", fields: draft.getFieldStrings(), time: existing && existing.kind === "draft" ? existing.time : now},title));
					}
				},parseInt(wiki.getTiddlerText("$:/config/cfworker/DraftPause",""),10) || DRAFT_PAUSE);
				return;
			}
			if(change.deleted) {
				if(draftTimers[title]) {
					clearTimeout(draftTimers[title]);
					delete draftTimers[title];
				}
				var wasDraft = drafts[title];
				delete drafts[title];
				delete received[title];
				if(dropping[title]) {
					delete dropping[title];   // (closed here on another tab's word: that tab told the others)
				} else if(wasDraft) {
					// Saved (its tiddler, or the one it's renamed to, changed in the same breath) or
					// cancelled: the other tabs close theirs
					var saved = !!changes[wasDraft.to] && !changes[wasDraft.to].deleted && wiki.tiddlerExists(wasDraft.to);
					justDropped[title] = now;
					tell({dropped: {title: title, of: wasDraft.of, to: saved ? wasDraft.to : null}});
				}
				if(info) {
					// Known to the worker: to delete there, from the version this run of changes
					// started from (a delete put back from the device keeps its own)
					var base = existing && existing.kind !== "draft" && typeof existing.base === "string" ? existing.base : String(info.revision);
					keep({title: title, kind: "delete", base: base, time: existing && existing.kind !== "draft" ? existing.time : now});
					tell({pending: {title: title, deleted: true}});
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
			if(!isKept(title)) {
				return;
			}
			keep({
				title: title, kind: "save", fields: tiddler.getFieldStrings(), count: count,
				// The server revision this run of changes started from, kept through later changes
				base: existing && existing.kind === "save" ? existing.base : (info ? String(info.revision) : null),
				time: existing && existing.kind !== "draft" ? existing.time : now
			});
			// The other tabs show it now, as the version this tab will save (design 1.16); the worker's
			// revision follows with the save's confirmation. Not a skinny one: no text to show.
			if(!tiddler.hasField("_is_skinny")) {
				tell({pending: {title: title, fields: tiddler.getFieldStrings()}});
			}
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
			var result = callback.apply(this,arguments);
			setTimeout(function() {
				tellHeld(title);   // (once the syncer and the guard have finished their bookkeeping for this answer)
			},0);
			return result;
		},options);
	};
	proto.deleteTiddler = function(title,callback,options) {
		return originalDeleteTiddler.call(this,title,function(err) {
			noteNetwork(err);
			settled(title,"delete",err);
			if(!err) {
				tell({deleted: title});
			}
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
		// (One channel per site: the page is served at /, /index.html and /baked.html alike)
		channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("cfworker-outbox") : null;
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
			} else if(data.draft) {
				takeDraft(data.draft);
			} else if(data.dropped) {
				dropDraft(data.dropped);
			} else if(data.saved) {
				takeSaved(data.saved);
			} else if(data.deleted) {
				takeDeleted(data.deleted);
			} else if(data.pending) {
				takePending(data.pending);
			}
		};
	}
	// The revision a draft is based on, as the conflict guard recorded it when the draft was made (a
	// draft's own revision field is TiddlyWiki's copy of its tiddler's, stale after this tab's own
	// save): carried with the draft to the other tabs and to the device, so that the tab that saves
	// it, whichever, sends the right If-Match. null is a base too (a tiddler the worker never had).
	function withBase(record,draftTitle) {
		var base = typeof proto.cfworkerDraftBase === "function" ? proto.cfworkerDraftBase(draftTitle) : undefined;
		if(typeof base !== "undefined") {
			(record.draft || record).base = {value: base};
		}
		return record;
	}
	function tellBase(draftTitle,of,base) {
		if(base && typeof proto.cfworkerDraftBaseFor === "function") {
			proto.cfworkerDraftBaseFor(draftTitle,of,base.value);
		}
	}
	function tell(message) {
		if(channel) {
			try {
				channel.postMessage(message);
			} catch(e) {
				// (a message that can't be sent is lost: the next poll, or the device, say the rest)
			}
		}
	}

	// --- Tabs following each other (design 1.16) --------------------------------------------------------

	// Whether this window is the one in use. TiddlyWiki's editors leave their text alone while their
	// textarea is the active element (the framed and the simple engine's setText), and the editor last
	// typed in stays the active element of a tab in the background, so it would never follow another
	// tab's typing, and the next keystroke in it would write its stale text over the draft. The
	// browser's own events say when this window is left: a tab switched away from, or a window left,
	// gets blur (and hidden); one come back to gets focus.
	var inUse = typeof document !== "object" || typeof document.hasFocus !== "function" || document.hasFocus();
	window.addEventListener("focus",function() {
		inUse = true;
	});
	window.addEventListener("blur",function() {
		inUse = false;
	});
	document.addEventListener("visibilitychange",function() {
		if(document.hidden) {
			inUse = false;
		}
	});
	// A draft another tab changed, put into this tab's editor on it where TiddlyWiki won't: only while
	// this window isn't in use, only the draft's body editor (the framed one, text field), and only its
	// textarea when it's the active element TiddlyWiki skipped; the caret goes to the end, as after any
	// outside change. With the window in use the person is typing here, and the editor is left alone,
	// as TiddlyWiki means it (2.27). Not for an editor a plugin brings (CodeMirror): its own.
	function followInEditor(draftTitle,text) {
		if(inUse || typeof document !== "object") {
			return;
		}
		var frames = document.querySelectorAll(".tc-tiddler-frame");
		for(var i = 0; i < frames.length; i++) {
			if(frames[i].getAttribute("data-tiddler-title") !== draftTitle) {
				continue;
			}
			var iframes = frames[i].querySelectorAll("iframe.tc-edit-texteditor-body");
			for(var j = 0; j < iframes.length; j++) {
				var doc = iframes[j].contentDocument,
					box = doc && doc.querySelector("textarea");
				if(box && doc.activeElement === box && box.value !== text) {
					try {
						box.value = text;
						box.setSelectionRange(text.length,text.length);
					} catch(e) {
						// (an editor that won't take it keeps what it has)
					}
				}
			}
		}
	}

	// Another tab's draft, as it is now: this tab's copy, for TiddlyWiki's drafts list and for any
	// editor open on it, which refreshes from the tiddler (or, the editor typed in last while this tab
	// is in the background, is given it: followInEditor). Not over a save or cancel of it made here a
	// moment ago, which that tab is about to hear of.
	function takeDraft(draft) {
		var title = draft.title;
		if(justDropped[title] && Date.now() - justDropped[title] < DROPPED_GRACE) {
			return;
		}
		var tiddler = new $tw.Tiddler(draft.fields);
		received[title] = tiddler;
		drafts[title] = {of: tiddler.fields["draft.of"], to: tiddler.fields["draft.title"] || tiddler.fields["draft.of"]};
		tellBase(title,tiddler.fields["draft.of"],draft.base);
		wiki.addTiddler(tiddler);
		followInEditor(title,tiddler.fields.text || "");
	}
	// Another tab saved or cancelled the draft: closed here as TiddlyWiki's cancel closes one, the
	// story showing in its place the tiddler saved (which arrives with the save) or, cancelled, the
	// one it was of; the entry goes if there's neither
	function dropDraft(dropped) {
		var title = dropped.title,
			draft = wiki.getTiddler(title);
		if(!draft || !draft.hasField("draft.of")) {
			delete received[title];
			delete drafts[title];
			return;
		}
		var story = wiki.getTiddlerList(STORY),
			pos = story.indexOf(title),
			to = dropped.to || dropped.of;
		// (The change event clears drafts and received, and the flag)
		if(pos !== -1) {
			if(to && (dropped.to || wiki.tiddlerExists(to))) {
				story[pos] = to;
			} else {
				story.splice(pos,1);
			}
			wiki.addTiddler(new $tw.Tiddler({title: STORY},wiki.getTiddler(STORY),{list: story}));
		}
		dropping[title] = true;
		wiki.deleteTiddler(title);
	}
	// A save another tab got confirmed: stored here as a load would be (the list sync)
	function takeSaved(saved) {
		var fields = saved.fields || {};
		fields.revision = saved.revision;
		fields.bag = fields.bag || "default";
		fields.recipe = fields.recipe || "default";
		fields.type = fields.type || "text/vnd.tiddlywiki";
		if(typeof proto.cfworkerTakeSaved === "function") {
			proto.cfworkerTakeSaved(fields);
		}
	}
	function takeDeleted(title) {
		if(typeof proto.cfworkerTakeDeleted === "function") {
			proto.cfworkerTakeDeleted(title);
		}
	}
	// A change another tab just made, not yet confirmed by the worker: shown here as the version that
	// tab will save, at the revision this tab knows (the list sync), so nothing is loaded over it and
	// nothing of it is sent from here; the confirmation, or the version adopted after a refusal,
	// follows as a save (takeSaved). A delete the same way.
	function takePending(pending) {
		if(pending.deleted) {
			return takeDeleted(pending.title);
		}
		if(typeof proto.cfworkerTakePending === "function") {
			proto.cfworkerTakePending(pending.fields || {});
		}
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
				// (A draft is the browser's, not a tab's: put back whoever holds it, design 1.16)
				if(entry.kind === "draft" || !heldElsewhere[entry.title]) {
					putBackEntry(entry,listed);
				}
			});
			updateStatus();
		});
	}
	function putBackEntry(entry,listed) {
		var title = entry.title;
		if(entry.kind === "draft") {
			// (Unless this tab already has a draft of that name: the one being typed wins. The other
			// tabs have it too, from the device or their own typing: not news to them.)
			if(!wiki.tiddlerExists(title)) {
				var draft = new $tw.Tiddler(entry.fields);
				entries[title] = entry;
				received[title] = draft;
				drafts[title] = {of: draft.fields["draft.of"], to: draft.fields["draft.title"] || draft.fields["draft.of"]};
				tellBase(title,draft.fields["draft.of"],entry.base);
				wiki.addTiddler(draft);
			}
		} else if(entry.kind === "save") {
			entries[title] = entry;
			proto.cfworkerBaseFor(title,entry.base);
			wiki.addTiddler(new $tw.Tiddler(entry.fields));
			entry.count = wiki.getChangeCount(title);
		} else if(entry.kind === "delete") {
			if(!$tw.utils.hop(listed,title)) {
				if(firstListFromCache) {
					// A cached list may simply predate the tiddler: kept until a real list says
					entries[title] = entry;
					deferred.push(entry);
					return;
				}
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
	proto.cfworkerOnList(function(listed,previous,tiddlers,fromCache) {
		// A list the service worker answered from its cache: the network gone, or the session (design
		// 2.26)? Access is asked, if the browser says it's online. A real one came through Access.
		if(fromCache) {
			probe();
		} else {
			setLogin("ok");
			setOnline(true);   // (the worker answered: the first word of its return when nothing waited to be sent)
		}
		if(!fromCache && deferred.length) {
			var waiting = deferred;
			deferred = [];
			$tw.utils.each(waiting,function(entry) {
				delete entries[entry.title];
				putBackEntry(entry,listed);
			});
			updateStatus();
		}
		if(previous === null) {
			firstList = listed;
			firstListFromCache = !!fromCache;
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
