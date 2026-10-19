/*\
title: $:/cfworker/list-sync.js
type: application/javascript
module-type: startup

How a tab syncs with the worker, apart from saves and deletes (those are the conflict guard,
$:/cfworker/conflict-guard.js):

- The tiddler list: which revision the worker lists for each tiddler, kept for the other modules
  (cfworkerListed, cfworkerOnList); while the worker rebuilds a damaged or missing list, requests it
  answers "rebuilding" are sent again quietly, and a list that can't be read is a sync error:
  TiddlyWiki would otherwise remove every tiddler it doesn't find in it, or stop with an "Internal
  JavaScript Error". Other modules can add a header to the list request and read its answer
  (cfworkerOnListRequest: the backup alert does).
- Loading (design 1.5). The list has everything but the text, and TiddlyWiki then loads every
  tiddler in full, one at a time, in the list's order. Here, the tiddler shown loads first; loaded
  tiddlers are kept on the device (IndexedDB), by revision, so a later page load fetches only what
  changed; the rest fills in several at a time, only while the tab is shown, and not at all with
  $:/config/cfworker/LoadAll set to "no" (then a tiddler loads the moment its text is needed; text
  search and backlinks only see the loaded ones). A fetch is accepted only at the revision the
  worker lists, so no cache can serve an older copy: refused, it's asked for again past any cache.
- Fewer worker requests: tiddler contents are fetched from the public copy of the wiki
  ($:/cfworker/public-url, served by R2/Cloudflare without the worker), and from the worker only
  when that copy doesn't have the listed revision (a private wiki has no public copy: from the
  worker, once per device); drafts and $:/StoryList, which the worker never
  stores, are not sent to it, and the "put" saver no longer probes the page URL on every load;
  background tabs stop polling for changes and catch up as soon as they are shown again.
- Titles the worker can't store aren't sent either (each save would fail, and be tried again
  forever): the tab asks to rename them instead (the outbox keeps them on the device meanwhile).
\*/
(function(){

"use strict";

exports.name = "cfworker-list-sync";
exports.platforms = ["browser"];
exports.after = ["load-modules"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

var LOAD_ALL_TITLE = "$:/config/cfworker/LoadAll",
	FILL_PAUSE = 200,     // ms after a list before the fill starts: what the page shows asks for its text first (as it is, not scaled)
	READ_AHEAD = 24,      // tiddlers looked up ahead of the one TiddlyWiki is loading (on the device, or fetched)
	FETCH_AHEAD = 6,      // ...of which fetched over the network at once ($:/config/cfworker/FetchAhead, the plugin's settings)
	CATCH_UP_AFTER = 10000,       // ms since the last list after which a tab shown again asks for one at once (as it is, not scaled)
	PUBLIC_READ_TIMEOUT = 5000,   // ms given to a read from the public site before the worker is asked instead
	REBUILDING_RETRY = 500,       // ms before the list is asked again while the worker rebuilds it ("rebuilding")
	STAND_IN_RETRY = 1000,        // ...and after a stand-in for a missing list (the first time, then STAND_IN_RETRY_LATER)
	STAND_IN_RETRY_LATER = 5000,
	FORGET_TIMEOUT = 5000,        // ms given to the browser to delete the device's database (cfworkerForgetDevice)
	// (The timeouts and retries, from PUBLIC_READ_TIMEOUT down, go through lib.wait: the tests scale
	// them, a deployed wiki has them as they are)
	STORE_DB = "cfworker-tiddlers",
	STORE_VERSION = 2,            // 1: the tiddlers table; 2: the outbox table too ($:/cfworker/outbox.js)
	STORE_NAME = "tiddlers",
	OUTBOX_NAME = "outbox",
	ACCESS_LOGOUT = "/cdn-cgi/access/logout";   // Cloudflare Access's logout page, on the admin site's own address

exports.startup = function() {
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || Adaptor.prototype.cfworkerListed) {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		originalLoadTiddler = proto.loadTiddler,
		originalGetSkinnyTiddlers = proto.getSkinnyTiddlers,
		publicBase = lib.publicBase(),
		PENDING_REVISION = "0",                // stands for the revision of a tiddler another tab made and hasn't saved yet (cfworkerTakePending)
		listedRevisions = Object.create(null), // title -> revision in the worker's latest tiddler list
		lastListFetch = 0,
		listRequested = 0,                     // when the request for that list was sent
		listListeners = [],                    // called with each new list (cfworkerOnList)
		listFromCache = false,                 // the last list was the service worker's copy, the network gone (design 1.11)
		requestHooks = [],                     // {headers(), answer(xhr)} for each list request (cfworkerOnListRequest)
		listBypassCache = false,               // the last list was the stand-in or unreadable (isListStandIn)
		lazyLoading = wiki.getTiddlerText("$:/config/SyncDisableLazyLoading") !== "yes",
		wanted = Object.create(null),          // titles whose text was asked for (shown) and not loaded yet
		explicit = Object.create(null),        // titles a module asked to load (enqueueLoadTiddler)
		loading = Object.create(null),         // titles being loaded now (cfworkerLoading)
		held = Object.create(null),            // the fill's titles, kept aside while it's held
		ahead = Object.create(null),           // title -> {promise, fields} looked up ahead of TiddlyWiki
		fetching = 0,                          // network fetches under way, and who waits for a slot
		fetchQueue = [],
		fillHoldUntil = 0,
		fillTimer = null,
		deliveryTimer = null;

	// TiddlyWeb's Logout (the cloud icon's dropdown) posts to a /logout route the worker doesn't
	// have: the session is Cloudflare Access's, ended at its own address (setup 2.6), which then
	// shows its login page. On the admin site only: the public site has no session, and no button.
	if(lib.onAdminSite(window.location.origin + "/")) {
		proto.logout = function() {
			window.location.href = ACCESS_LOGOUT;
		};
	}

	// The "put" saver probes the page URL (OPTIONS + HEAD) on every load, but it can't save to the
	// worker (saving goes through the sync adaptor), so switch it off
	$tw.modules.forEachModuleOfType("saver",function(title,module) {
		if(title === "$:/core/modules/savers/put.js") {
			module.canSave = function() {
				return false;
			};
		}
	});

	// Once per title in this tab
	var askedToRename = Object.create(null),
		renameLogger = $tw.utils.Logger ? new $tw.utils.Logger("cfworker") : null;
	function askToRename(title) {
		if(askedToRename[title] || !renameLogger) {
			return;
		}
		askedToRename[title] = true;
		renameLogger.alert(lib.link(title) + " can't be saved: the server doesn't take a tiddler titled \".\" or \"..\", or a title over " +
			lib.MAX_TITLE_BYTES + " bytes. Rename it to save it; until then it's kept on this device, unsent.");
	}

	// --- The fill: TiddlyWiki's loads, arranged -------------------------------------------------------

	// Whether every tiddler is loaded in full in the background, as TiddlyWiki does (the setting's
	// "no" turns that off, unless TiddlyWiki's own lazy loading is off: then every load must go through)
	function fillOn() {
		var setting = wiki.getTiddler(LOAD_ALL_TITLE);
		return !lazyLoading || !(setting && String(setting.fields.text || "").trim().toLowerCase() === "no");
	}
	function isSkinny(title) {
		var tiddler = wiki.getTiddler(title);
		return !tiddler || tiddler.hasField("_is_skinny");
	}
	// A load TiddlyWiki queued only because the list showed a revision of a tiddler this tab has
	// skinny: the fill. Anything else is for a tiddler that's shown (wanted), that a module asked for
	// (explicit), or that the tab holds in full and the worker has a newer version of.
	function isFill(title) {
		return !wanted[title] && !explicit[title] && isSkinny(title);
	}
	function sameOrder(a,b) {
		if(a.length !== b.length) {
			return false;
		}
		for(var i = 0; i < a.length; i++) {
			if(a[i] !== b[i]) {
				return false;
			}
		}
		return true;
	}
	// The loads TiddlyWiki queued (titlesToBeLoaded, loaded one at a time from the first key), arranged
	// before it picks the next: what's shown first, then what was asked for, the fill after them. The
	// fill is kept aside (held) while the tab is hidden and for a moment after each list, so what the
	// page shows asks for its text first; with the fill off, those loads are dropped: the skinny
	// tiddler stays, and loads the moment its text is needed.
	function arrangeLoads(syncer) {
		var queue = syncer.titlesToBeLoaded,
			titles = Object.keys(queue),
			on = fillOn(),
			hold = !on || document.hidden || Date.now() < fillHoldUntil,
			first = [],
			then = [],
			fill = [];
		$tw.utils.each(titles,function(title) {
			if(wanted[title]) {
				first.push(title);
			} else if(!isFill(title)) {
				then.push(title);
			} else if(listedRevisions[title]) {
				fill.push(title);
			}
			// (A fill load of a tiddler the worker no longer lists is dropped: TiddlyWiki has removed it)
		});
		// (Titles whose text was asked for and has come since: no longer first)
		$tw.utils.each(Object.keys(wanted),function(title) {
			if(!isSkinny(title) && !queue[title]) {
				delete wanted[title];
			}
		});
		if(!on) {
			held = Object.create(null);
			fill = [];
		} else if(hold) {
			$tw.utils.each(fill,function(title) {
				held[title] = true;
			});
			if(!document.hidden && !fillTimer && (fill.length || $tw.utils.count(held))) {
				fillTimer = setTimeout(function() {
					fillTimer = null;
					syncer.processTaskQueue();
				},Math.max(0,fillHoldUntil - Date.now()) + 10);
			}
			fill = [];
		} else {
			$tw.utils.each(Object.keys(held),function(title) {
				if(listedRevisions[title] && wiki.tiddlerExists(title) && fill.indexOf(title) === -1 && first.indexOf(title) === -1 && then.indexOf(title) === -1) {
					fill.push(title);
				}
			});
			held = Object.create(null);
		}
		var ordered = first.concat(then,fill);
		if(!sameOrder(titles,ordered)) {
			var arranged = Object.create(null);
			$tw.utils.each(ordered,function(title) {
				arranged[title] = true;
			});
			syncer.titlesToBeLoaded = arranged;
		}
	}

	if($tw.Syncer && !$tw.Syncer.prototype.cfworkerPatched) {
		var originalGetSyncedTiddlers = $tw.Syncer.prototype.getSyncedTiddlers,
			originalChooseNextTask = $tw.Syncer.prototype.chooseNextTask,
			originalEnqueueLoadTiddler = $tw.Syncer.prototype.enqueueLoadTiddler;
		$tw.Syncer.prototype.cfworkerPatched = true;
		// Keep drafts and the story list out of syncing: the worker never stores them (the same rule:
		// $:/StoryList itself, and a draft.of field, even empty, as TiddlyWiki tells drafts). For drafts
		// it also matters because after the next poll the syncer would see them as "missing from the
		// server" and delete the open draft, closing the editor.
		// Nor a title the worker can't store (storableTitle): each save would fail, and be tried again
		// forever. The tab says to rename it instead.
		$tw.Syncer.prototype.getSyncedTiddlers = function(source) {
			var syncerWiki = this.wiki;
			return originalGetSyncedTiddlers.call(this,source).filter(function(title) {
				var tiddler = syncerWiki.getTiddler(title);
				if(!lib.storableTitle(title)) {
					if(tiddler) {
						askToRename(title);
					}
					return false;
				}
				return title !== "$:/StoryList" && !(tiddler && tiddler.hasField("draft.of"));
			});
		};
		// Don't poll for changes while the tab is in the background (saves still go out), and arrange
		// the loads before TiddlyWiki picks the next
		$tw.Syncer.prototype.chooseNextTask = function() {
			if(document.hidden && !this.forceSyncFromServer && this.timestampLastSyncFromServer) {
				this.timestampLastSyncFromServer = new Date();
			}
			arrangeLoads(this);
			return originalChooseNextTask.call(this);
		};
		// A load a module asks for is never the fill
		$tw.Syncer.prototype.enqueueLoadTiddler = function(title) {
			explicit[title] = true;
			return originalEnqueueLoadTiddler.apply(this,arguments);
		};
		// ...and catch up as soon as it is shown again (the fill too)
		document.addEventListener("visibilitychange",function() {
			var s = $tw.syncer;
			if(!document.hidden && s && s.syncadaptor && typeof s.syncadaptor.cfworkerListed === "function") {
				if(Date.now() - lastListFetch > CATCH_UP_AFTER) {
					s.syncFromServer();
				}
				s.processTaskQueue();
			}
		});
	}
	// What the page shows asks for its text: loaded before anything else
	if(lazyLoading) {
		wiki.addEventListener("lazyLoad",function(title) {
			if(!loading[title]) {
				wanted[title] = true;
			}
		});
	}

	// --- The device's copy of loaded tiddlers (IndexedDB) ----------------------------------------------
	// One database, two tables: the tiddlers loaded (here), and the outbox, the changes made on this
	// device that the worker doesn't have yet ($:/cfworker/outbox.js, through cfworkerOutboxRequest).
	// The device tab measures both and can remove the database ($:/cfworker/device.js, the end of
	// this file).

	var storeOff = typeof indexedDB !== "object" || !indexedDB,
		storeOpening = null;
	function storeDb() {
		if(storeOff) {
			return Promise.resolve(null);
		}
		if(!storeOpening) {
			storeOpening = new Promise(function(resolve) {
				var request;
				try {
					request = indexedDB.open(STORE_DB,STORE_VERSION);
				} catch(e) {
					storeOff = true;
					return resolve(null);
				}
				request.onupgradeneeded = function() {
					var db = request.result;
					$tw.utils.each([STORE_NAME,OUTBOX_NAME],function(name) {
						if(!db.objectStoreNames.contains(name)) {
							db.createObjectStore(name,{keyPath: "title"});
						}
					});
				};
				request.onsuccess = function() {
					var db = request.result;
					// Closed when another tab or the browser replaces the database: opened again at the next use
					db.onversionchange = function() {
						db.close();
						storeOpening = null;
					};
					resolve(db);
				};
				request.onerror = function() {
					storeOff = true;
					resolve(null);
				};
				request.onblocked = function() {
					storeOpening = null;   // (being replaced: tried again at the next use)
					resolve(null);
				};
			});
		}
		return storeOpening;
	}
	// work(objectStore) makes the request on the table named (the tiddlers by default); resolves with
	// its result, null for anything that fails
	function storeRequest(mode,work,name) {
		return storeDb().then(function(db) {
			if(!db) {
				return null;
			}
			return new Promise(function(resolve) {
				try {
					var transaction = db.transaction(name || STORE_NAME,mode),
						request = work(transaction.objectStore(name || STORE_NAME));
					request.onsuccess = function() {
						resolve(request.result === undefined ? null : request.result);
					};
					request.onerror = transaction.onerror = transaction.onabort = function() {
						resolve(null);
					};
				} catch(e) {
					resolve(null);
				}
			});
		});
	}
	function storeGet(title) {
		return storeRequest("readonly",function(store) {
			return store.get(title);
		});
	}
	function storeKeys() {
		return storeRequest("readonly",function(store) {
			return store.getAllKeys();
		});
	}
	function keep(title,fields) {
		if(!fields || fields.revision === undefined || fields.revision === null) {
			return;
		}
		storeRequest("readwrite",function(store) {
			return store.put({title: title, revision: String(fields.revision), fields: fields});
		});
	}
	function forget(titles) {
		if(!titles.length) {
			return;
		}
		storeRequest("readwrite",function(store) {
			var request = null;
			$tw.utils.each(titles,function(title) {
				request = store["delete"](title);
			});
			return request;
		});
	}
	// Entries for tiddlers the worker no longer lists, after the first list of this page load
	function prune() {
		storeKeys().then(function(keys) {
			if(keys) {
				forget(keys.filter(function(title) {
					return !$tw.utils.hop(listedRevisions,title);
				}));
			}
		});
	}

	// --- Reading tiddlers -------------------------------------------------------------------------------

	// Where a tiddler is read from without the worker: {url, sameSite}, the public copy of the wiki
	// (the admin site reads it from there: another site) or this site itself on the public site;
	// null when there's none
	function tiddlerUrl(adaptor,title) {
		var path = "recipes/" + encodeURIComponent(adaptor.recipe || "default") + "/tiddlers/" + encodeURIComponent(title);
		if(publicBase && lib.siteOf(publicBase) !== lib.siteOf(adaptor.host)) {
			return {url: publicBase + path, sameSite: false};
		}
		return adaptor.host ? {url: adaptor.host + path, sameSite: true} : null;
	}
	// The setting, 1 at least: under that nothing would ever start, and the fill would never end
	function fetchAhead() {
		return Math.max(1,parseInt(wiki.getTiddlerText("$:/config/cfworker/FetchAhead",""),10) || FETCH_AHEAD);
	}
	// A slot for a network fetch (fetchAhead() at a time); urgent: ahead of those waiting for one
	function withFetchSlot(work,urgent) {
		return new Promise(function(resolve) {
			function start() {
				fetching++;
				Promise.resolve().then(work).then(function(value) {
					release();
					resolve(value);
				},function() {
					release();
					resolve(null);
				});
			}
			if(fetching < fetchAhead()) {
				start();
			} else if(urgent) {
				fetchQueue.unshift(start);
			} else {
				fetchQueue.push(start);
			}
		});
	}
	function release() {
		fetching--;
		var next = fetchQueue.shift();
		if(next) {
			next();
		}
	}
	// Fetches the tiddler at url: its fields if it's exactly the expected revision, null if it's
	// another revision, false if it couldn't be fetched at all. A site that doesn't answer (rather
	// than fails) mustn't hold up loading: given up after a few seconds. Always revalidated with the
	// server (no-cache); from another site, without credentials (the public site is another origin
	// for the admin site, with a plain CORS header).
	function fetchRevision(adaptor,url,sameSite,title,expected) {
		var controller = typeof AbortController === "function" ? new AbortController() : null,
			timer = controller && setTimeout(function() {
				controller.abort();
			},lib.wait(PUBLIC_READ_TIMEOUT));
		return fetch(url,{cache: "no-cache", credentials: sameSite ? "same-origin" : "omit", signal: controller ? controller.signal : undefined})
			.then(function(response) {
				return response.ok ? response.json() : false;
			})
			.then(function(data) {
				clearTimeout(timer);
				if(data === false) {
					return false;
				}
				try {
					if(data && data.title === title && data.revision !== undefined && data.revision !== null && String(data.revision) === expected) {
						return adaptor.convertTiddlerFromTiddlyWebFormat(data);
					}
				} catch(e) {}
				return null;
			},function() {
				clearTimeout(timer);
				return false;
			});
	}
	// The listed revision, fetched without the worker; a copy a cache kept from before a change is
	// refused, and the tiddler asked for again at a URL no cache holds
	function fetchListed(adaptor,title,expected,urgent) {
		var at = tiddlerUrl(adaptor,title);
		if(!at || typeof fetch !== "function") {
			return Promise.resolve(null);
		}
		return withFetchSlot(function() {
			return fetchRevision(adaptor,at.url,at.sameSite,title,expected).then(function(fields) {
				return fields === null ? fetchRevision(adaptor,at.url + "?cfworker-retry=" + Date.now(),at.sameSite,title,expected) : fields;
			}).then(function(fields) {
				return fields || null;
			});
		},urgent);
	}
	// The tiddler's fields at the revision the worker lists: from the device, or fetched (and kept);
	// null if neither has it
	function lookUp(adaptor,title,urgent) {
		var expected = listedRevisions[title];
		if(!expected) {
			return Promise.resolve(null);
		}
		return storeGet(title).then(function(kept) {
			// (With no network, the list is the last one kept: the device's copy is the best there is,
			// whatever its revision, a save of this device's since then included)
			if(kept && kept.fields && (kept.revision === expected || listFromCache)) {
				return kept.fields;
			}
			return fetchListed(adaptor,title,expected,urgent).then(function(fields) {
				if(fields) {
					keep(title,fields);
				}
				return fields;
			});
		});
	}
	// The next tiddlers TiddlyWiki will load, looked up ahead of it (the fill: not while held)
	function readAhead(adaptor) {
		var s = $tw.syncer;
		if(!s || document.hidden || !fillOn()) {
			return;
		}
		var queued = Object.keys(s.titlesToBeLoaded),
			count = $tw.utils.count(ahead);
		for(var i = 0; i < queued.length && count < READ_AHEAD; i++) {
			var title = queued[i];
			if(!ahead[title] && !loading[title] && listedRevisions[title]) {
				ahead[title] = lookAhead(adaptor,title);
				count++;
			}
		}
	}
	function lookAhead(adaptor,title) {
		var entry = {promise: null, fields: undefined};
		entry.promise = lookUp(adaptor,title).then(function(fields) {
			entry.fields = fields;
			scheduleDelivery(adaptor);
			return fields;
		});
		return entry;
	}
	// Once the tiddlers looked up ahead stop arriving for a moment, they're delivered together, and
	// the next ones looked up: the fill goes on in batches, without waiting for TiddlyWiki's loads
	var DELIVERY_PAUSE = 40;
	function scheduleDelivery(adaptor) {
		clearTimeout(deliveryTimer);
		deliveryTimer = setTimeout(function() {
			deliveryTimer = null;
			deliverAhead();
			readAhead(adaptor);
		},DELIVERY_PAUSE);
	}
	// The tiddlers looked up ahead still on their way, waited for: all of them, or DELIVERY_PAUSE at
	// most (the device answers within it; the network needn't)
	function settleAhead() {
		var pending = [];
		$tw.utils.each(ahead,function(entry) {
			if(entry.fields === undefined) {
				pending.push(entry.promise);
			}
		});
		if(!pending.length) {
			return Promise.resolve();
		}
		return Promise.race([Promise.all(pending),new Promise(function(resolve) {
			setTimeout(resolve,DELIVERY_PAUSE);
		})]);
	}
	// Tiddlers looked up ahead that have arrived, stored now, together (one refresh for all of them),
	// so TiddlyWiki needn't load them one by one. (One the list has moved on from meanwhile is
	// dropped: its load fetches the listed revision.)
	function deliverAhead() {
		var s = $tw.syncer;
		$tw.utils.each(Object.keys(ahead),function(title) {
			var entry = ahead[title];
			if(entry.fields === undefined || entry.fields === null) {
				return;
			}
			delete ahead[title];
			if(String(entry.fields.revision) !== listedRevisions[title]) {
				return;
			}
			if(s && s.titlesToBeLoaded[title] && !loading[title] && !hasUnsavedChanges(title)) {
				delete s.titlesToBeLoaded[title];
				delete wanted[title];
				delete explicit[title];
				s.storeTiddler(entry.fields);
			}
		});
	}

	// Public tabs read the list straight from R2, so while the worker rebuilds a missing list they
	// get the text standing in for it (the worker's listStandIn: keep the two in step). It isn't
	// JSON, so TiddlyWiki can't take it for a list. It's fetched again a little later (only the
	// worker's own requests move the rebuild on). After the stand-in or a list that can't be read,
	// the list is fetched at a URL no cache holds until a good one comes back: a cached copy (the
	// browser keeps one for a few minutes) could otherwise outlive the rebuild.
	var LIST_STAND_IN_MARK = "Tiddler list being rebuilt";
	function isListStandIn(request) {
		return !!request && request.status === 200 && typeof request.responseText === "string" &&
			request.responseText.indexOf(LIST_STAND_IN_MARK) === 0;
	}
	// TiddlyWiki removes every tiddler that isn't in the list it gets, so anything that isn't a list
	// of tiddlers (a damaged upload, say) must be an error, not an empty list
	function isTiddlerList(tiddlers) {
		if(!$tw.utils.isArray(tiddlers)) {
			return false;
		}
		for(var i = 0; i < tiddlers.length; i++) {
			if(!tiddlers[i] || typeof tiddlers[i].title !== "string") {
				return false;
			}
		}
		return true;
	}

	function hasUnsavedChanges(title) {
		var s = $tw.syncer;
		if(!s || !wiki.tiddlerExists(title)) {
			return false;
		}
		var info = s.tiddlerInfo[title];
		if(info) {
			return wiki.getChangeCount(title) > info.changeCount;
		}
		return s.getSyncedTiddlers([title]).length > 0;
	}

	// Remember which revision the worker currently lists for each tiddler, fetch the list again while
	// it's being rebuilt (isRebuilding, isListStandIn), and never pass on a list that isn't one
	proto.getSkinnyTiddlers = function(callback) {
		var self = this,
			tries = 0;
		function fetchList() {
			// The adaptor passes on only the error text: catch the request it makes, to read its header.
			// It makes it straight away, so the wrapper is in place only during this call.
			var requested = Date.now(),
				request = null,
				delivered = false,
				unreadable = false,
				bypassed = listBypassCache,
				asking = [],     // the hooks adding headers to this request, with their headers
				httpRequest = $tw.utils.httpRequest;
			$tw.utils.each(requestHooks,function(hook) {
				var headers = hook.headers(self);
				if(headers) {
					asking.push({hook: hook, headers: headers});
				}
			});
			$tw.utils.httpRequest = function(options) {
				var done = options.callback;
				if(listBypassCache) {
					options.data = $tw.utils.extend({},options.data,{"cfworker-retry": String(Date.now())});
				}
				$tw.utils.each(asking,function(entry) {
					options.headers = $tw.utils.extend({},options.headers,entry.headers);
				});
				options.callback = function(err,data,xhr) {
					request = xhr;
					$tw.utils.each(asking,function(entry) {
						try {
							entry.hook.answer(xhr);
						} catch(e) {
							console.error("cfworker: a tiddler list request hook failed:",e);
						}
					});
					try {
						return done.apply(this,arguments);
					} catch(e) {
						// The adaptor parses the list itself and throws if it isn't JSON, which would stop
						// syncing with an "Internal JavaScript Error": reported as a sync error instead
						if(err || delivered) {
							throw e;
						}
						unreadable = true;
						return done.call(this,"the tiddler list can't be read (" + e.message + ")",null,xhr);
					}
				};
				return httpRequest.apply(this,arguments);
			};
			try {
				originalGetSkinnyTiddlers.call(self,listFetched);
			} finally {
				$tw.utils.httpRequest = httpRequest;
			}
			function listFetched(err,tiddlers) {
				delivered = true;
				if(!err && !isTiddlerList(tiddlers)) {
					err = "the tiddler list can't be read (it isn't a list of tiddlers)";
					tiddlers = null;
					unreadable = true;
				}
				if(unreadable || isListStandIn(request)) {
					listBypassCache = true;
					// Maybe only a copy the browser kept: asked again at once, past it, before reporting
					if(unreadable && !bypassed && !isListStandIn(request)) {
						return setTimeout(fetchList,0);
					}
				} else if(!err) {
					listBypassCache = false;
				}
				if(err && ++tries <= lib.REBUILD_RETRIES) {
					if(lib.isRebuilding(request)) {
						return setTimeout(fetchList,lib.wait(REBUILDING_RETRY));
					}
					if(isListStandIn(request)) {
						return setTimeout(fetchList,lib.wait(tries === 1 ? STAND_IN_RETRY : STAND_IN_RETRY_LATER));
					}
				}
				if(err) {
					return callback(err,tiddlers);
				}
				var previous = lastListFetch ? listedRevisions : null,
					fromCache = !!(request && request.getResponseHeader && request.getResponseHeader("X-Served-From") === "cache");
				completeList(tiddlers,previous,fromCache,function(list) {
					listFromCache = fromCache;
					listedRevisions = Object.create(null);
					$tw.utils.each(list,function(fields) {
						if(fields.revision !== undefined && fields.revision !== null) {
							listedRevisions[fields.title] = String(fields.revision);
						}
					});
					lastListFetch = Date.now();
					listRequested = requested;
					fillHoldUntil = Date.now() + FILL_PAUSE;
					// (A cached list removes nothing: completeList)
					if(fromCache) {
						// nothing forgotten
					} else if(previous) {
						forget(Object.keys(previous).filter(function(title) {
							return !$tw.utils.hop(listedRevisions,title);
						}));
					} else {
						prune();
					}
					$tw.utils.each(listListeners,function(listener) {
						try {
							listener(listedRevisions,previous,list,fromCache);
						} catch(e) {
							console.error("cfworker: a tiddler list listener failed:",e);
						}
					});
					callback(null,list);
				});
			}
		}
		fetchList();
	};

	// A list the service worker answered from its cache, the network gone (design 1.11), can be
	// older than this device's last saves, and TiddlyWiki removes from the tab whatever a list
	// doesn't name. So a cached list can only add: it's completed with what the tab knew — its last
	// list and its own saves since (previous) — and, at a page load, with the device's copy, each at
	// its known revision, so nothing is reloaded and nothing goes; the next real list removes what
	// was deleted elsewhere meanwhile. then(list) with the completed list; a real list is passed on
	// as it is.
	function completeList(tiddlers,previous,fromCache,then) {
		if(!fromCache) {
			return then(tiddlers);
		}
		var seen = Object.create(null),
			list = tiddlers.slice();
		$tw.utils.each(tiddlers,function(fields) {
			seen[fields.title] = true;
		});
		function add(fields) {
			if(!seen[fields.title]) {
				seen[fields.title] = true;
				list.push(fields);
			}
		}
		if(previous) {
			$tw.utils.each(previous,function(revision,title) {
				add({title: title, revision: revision});
			});
			return then(list);
		}
		storeRequest("readonly",function(store) {
			return store.getAll();
		}).then(function(entries) {
			$tw.utils.each(entries || [],function(entry) {
				if(entry && entry.fields && typeof entry.title === "string") {
					var fields = $tw.utils.extend({},entry.fields);
					delete fields.text;
					fields.title = entry.title;
					fields.revision = entry.revision;
					add(fields);
				}
			});
			then(list);
		});
	}

	// The worker's latest tiddler list, title -> revision (null before the first): the page publisher
	// ($:/cfworker/page-publisher.js) uses it to tell the tiddlers that came with the page from the
	// stored ones
	proto.cfworkerListed = function() {
		return lastListFetch ? listedRevisions : null;
	};

	// When the request for that list was sent: a save or delete this tab finished after that may not
	// be in it yet
	proto.cfworkerListedSince = function() {
		return listRequested;
	};

	// listener(listed, previous, entries, fromCache) at each new tiddler list: listed and previous are
	// title -> revision (previous: the list before, null for the first), entries the list's tiddlers
	// (fields), fromCache whether it's the service worker's copy, completed (completeList), rather
	// than the worker's
	proto.cfworkerOnList = function(listener) {
		listListeners.push(listener);
	};

	// hook: {headers(adaptor): headers to add to the next list request, or null for none this time;
	// answer(xhr): called with the request once answered, when headers were added}
	proto.cfworkerOnListRequest = function(hook) {
		requestHooks.push(hook);
	};

	// A revision this tab now knows the worker has (a save of its own): what the next read expects,
	// until the next list; tiddler: the tiddler saved, kept on the device at that revision (not a
	// skinny one: the worker kept the stored text, which this tab doesn't have)
	proto.cfworkerNoteListed = function(title,revision,tiddler) {
		listedRevisions[title] = revision;
		if(tiddler && !tiddler.hasField("_is_skinny")) {
			var fields = tiddler.getFieldStrings();
			fields.type = fields.type || "text/vnd.tiddlywiki";
			fields.revision = String(revision);
			fields.bag = "default";
			fields.recipe = "default";
			keep(title,fields);
		}
	};

	// A tiddler this tab deleted: no longer on the device either
	proto.cfworkerNoteDeleted = function(title) {
		delete listedRevisions[title];
		forget([title]);
	};

	// A save another tab of this browser got confirmed (the outbox's channel, design 1.16): the tiddler
	// as the worker now has it, with its revision, stored as a load would be, so the next list finds
	// nothing to load; not over an unsaved change of this tab's, which the conflict guard settles at
	// its save. The saving tab wrote the device copy. Returns whether it was taken.
	proto.cfworkerTakeSaved = function(fields) {
		var s = $tw.syncer,
			title = fields.title;
		if(!s || hasUnsavedChanges(title)) {
			return false;
		}
		listedRevisions[title] = String(fields.revision);
		delete ahead[title];
		delete held[title];
		delete wanted[title];
		delete explicit[title];
		delete s.titlesToBeLoaded[title];
		s.storeTiddler(fields);
		return true;
	};
	// A change another tab made and hasn't had confirmed yet (the outbox's channel, design 1.16): shown
	// here as that version, at the revision this tab knows for the tiddler, so that the next list, if it
	// still says that revision, loads nothing over it, and the syncer, holding it as the worker's, sends
	// nothing of it; a tiddler this tab has never seen listed gets a stand-in revision ("0", never the
	// worker's, and no base for the conflict guard), kept in the listed revisions too, so a list the
	// service worker answers from its cache while offline (completeList) doesn't take it for gone.
	// The confirmation follows as a save (cfworkerTakeSaved). Not over an unsaved change of this tab's.
	proto.cfworkerTakePending = function(fields) {
		var s = $tw.syncer,
			title = fields.title;
		if(!s || hasUnsavedChanges(title)) {
			return false;
		}
		var info = s.tiddlerInfo[title],
			revision = info && info.revision !== undefined && info.revision !== null ? String(info.revision) : (listedRevisions[title] || PENDING_REVISION);
		fields.revision = revision;
		fields.bag = fields.bag || "default";
		fields.recipe = fields.recipe || "default";
		fields.type = fields.type || "text/vnd.tiddlywiki";
		if(!listedRevisions[title]) {
			listedRevisions[title] = revision;   // (a tiddler never listed here: the stand-in, until a list names it)
		}
		delete ahead[title];
		delete held[title];
		delete wanted[title];
		delete explicit[title];
		delete s.titlesToBeLoaded[title];
		s.storeTiddler(fields);
		return true;
	};
	// A delete another tab got confirmed: applied as a list that no longer names the tiddler is
	// (TiddlyWiki's own order: forgotten by the syncer first, so no delete of this tab's follows)
	proto.cfworkerTakeDeleted = function(title) {
		var s = $tw.syncer;
		if(!s || hasUnsavedChanges(title)) {
			return false;
		}
		delete listedRevisions[title];
		proto.cfworkerDropLoad(title);
		delete s.tiddlerInfo[title];
		if(wiki.tiddlerExists(title)) {
			wiki.deleteTiddler(title);
		}
		return true;
	};

	// The titles being loaded right now (title -> true): the page publisher waits for the ones its
	// page needs, not for the fill
	proto.cfworkerLoading = function() {
		return loading;
	};

	// How many fill loads are held back for the moment (after a list, while the tab is hidden): they're
	// out of TiddlyWiki's queue meanwhile, so the syncer looks idle (the tests wait for them too)
	proto.cfworkerHeld = function() {
		return $tw.utils.count(held);
	};

	// A request on the device database's outbox table, for the outbox module: work(objectStore)
	// makes it; resolves with its result, null for anything that fails (no IndexedDB, say)
	proto.cfworkerOutboxRequest = function(mode,work) {
		return storeRequest(mode,work,OUTBOX_NAME);
	};
	// The same on the tiddlers table, and the titles the worker's last list had: the device tab's
	// measure ($:/cfworker/device.js)
	proto.cfworkerDeviceRequest = function(mode,work) {
		return storeRequest(mode,work,STORE_NAME);
	};
	proto.cfworkerListedTitles = function() {
		return Object.keys(listedRevisions);
	};
	// The device database removed (the device tab's Forget, which reloads the page after): this tab's
	// connection closed first and nothing opened again meanwhile, the other tabs' closed by their
	// versionchange handler (above). Resolves true once it's gone — or after a few seconds if a
	// connection hasn't closed: the removal then goes through when it does, before the reloaded page's
	// own open; null when there's no database to remove; false when the browser refuses.
	proto.cfworkerForgetDevice = function() {
		if(storeOff) {
			return Promise.resolve(null);
		}
		return storeDb().then(function(db) {
			if(db) {
				db.close();
			}
			storeOpening = null;
			storeOff = true;
			return new Promise(function(resolve) {
				var request,
					timer = setTimeout(function() {
						resolve(true);
					},lib.wait(FORGET_TIMEOUT));
				function done(ok) {
					clearTimeout(timer);
					if(!ok) {
						storeOff = false;
					}
					resolve(ok);
				}
				try {
					request = indexedDB.deleteDatabase(STORE_DB);
				} catch(e) {
					return done(false);
				}
				request.onsuccess = function() {
					done(true);
				};
				request.onerror = function() {
					done(false);
				};
			});
		});
	};

	// A tiddler deleted here before its load came (a delete kept on the device, put back at this
	// page load): its load is dropped, from TiddlyWiki's queue and from the fill held aside
	proto.cfworkerDropLoad = function(title) {
		delete held[title];
		delete wanted[title];
		if($tw.syncer) {
			delete $tw.syncer.titlesToBeLoaded[title];
		}
	};

	// Never let a background reload overwrite local changes that haven't been uploaded yet; the
	// pending save will detect any conflict instead. Otherwise the device's copy, the public site,
	// then the worker (loadTiddler as TiddlyWiki has it).
	proto.loadTiddler = function(title,callback) {
		var self = this;
		loading[title] = true;
		delete wanted[title];
		delete explicit[title];
		function done(err,fields) {
			delete loading[title];
			callback(err,fields);
		}
		if(hasUnsavedChanges(title)) {
			return done(null,null);
		}
		var entry = ahead[title],
			found = entry ? entry.promise.then(function(fields) {
				// (Looked up ahead, unless the list has moved on since)
				return fields && String(fields.revision) !== listedRevisions[title] ? lookUp(self,title,true) : fields;
			}) : lookUp(self,title,true);
		delete ahead[title];
		found.then(function(fields) {
			if(fields && hasUnsavedChanges(title)) {
				return done(null,null);
			}
			if(fields) {
				// Delivered with the tiddlers looked up ahead that arrive meanwhile: one refresh for
				// all of them, and TiddlyWiki's next load finds the queue that much shorter
				return settleAhead().then(function() {
					deliverAhead();
					readAhead(self);
					done(null,fields);
				});
			}
			originalLoadTiddler.call(self,title,function(err,fields) {
				if(!err && fields && hasUnsavedChanges(title)) {
					return done(null,null);
				}
				if(!err && fields) {
					keep(title,fields);
				}
				readAhead(self);
				done(err,fields);
			});
		});
	};
};

})();
