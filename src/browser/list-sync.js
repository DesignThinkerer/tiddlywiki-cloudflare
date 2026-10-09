/*\
title: $:/cfworker/list-sync.js
type: application/javascript
module-type: startup

How the admin tab syncs with the worker, apart from saves and deletes (those are the conflict guard,
$:/cfworker/conflict-guard.js):

- The tiddler list: which revision the worker lists for each tiddler, kept for the other modules
  (cfworkerListed, cfworkerOnList); while the worker rebuilds a damaged or missing list, requests it
  answers "rebuilding" are sent again quietly, and a list that can't be read is a sync error:
  TiddlyWiki would otherwise remove every tiddler it doesn't find in it, or stop with an "Internal
  JavaScript Error". Other modules can add a header to the list request and read its answer
  (cfworkerOnListRequest: the backup alert does).
- Fewer worker requests: tiddler contents are fetched from the public copy of the wiki
  ($:/cfworker/public-url, served by R2/Cloudflare without the worker) when it holds exactly the
  revision the worker listed, otherwise from the worker as usual; drafts and $:/StoryList, which the
  worker never stores, are not sent to it, and the "put" saver no longer probes the page URL on
  every load; background tabs stop polling for changes and catch up as soon as they are shown again.
- Titles the worker can't store aren't sent either (each save would fail, and be tried again
  forever): the tab asks to rename them instead.
\*/
(function(){

"use strict";

exports.name = "cfworker-list-sync";
exports.platforms = ["browser"];
exports.after = ["load-modules"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

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
		listedRevisions = Object.create(null), // title -> revision in the worker's latest tiddler list
		lastListFetch = 0,
		listRequested = 0,                     // when the request for that list was sent
		listListeners = [],                    // called with each new list (cfworkerOnList)
		requestHooks = [],                     // {headers(), answer(xhr)} for each list request (cfworkerOnListRequest)
		listBypassCache = false;               // the last list was the stand-in or unreadable (isListStandIn)

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
			lib.MAX_TITLE_BYTES + " bytes. Rename it to keep it; until then it's only in this tab.");
	}

	if($tw.Syncer && !$tw.Syncer.prototype.cfworkerPatched) {
		var originalGetSyncedTiddlers = $tw.Syncer.prototype.getSyncedTiddlers,
			originalChooseNextTask = $tw.Syncer.prototype.chooseNextTask;
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
		// Don't poll for changes while the tab is in the background (saves still go out)
		$tw.Syncer.prototype.chooseNextTask = function() {
			if(document.hidden && !this.forceSyncFromServer && this.timestampLastSyncFromServer) {
				this.timestampLastSyncFromServer = new Date();
			}
			return originalChooseNextTask.call(this);
		};
		// ...and catch up as soon as it is shown again
		document.addEventListener("visibilitychange",function() {
			var s = $tw.syncer;
			if(!document.hidden && s && s.syncadaptor && typeof s.syncadaptor.cfworkerListed === "function" && Date.now() - lastListFetch > 10000) {
				s.syncFromServer();
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
						return setTimeout(fetchList,500);
					}
					if(isListStandIn(request)) {
						return setTimeout(fetchList,tries === 1 ? 1000 : 5000);
					}
				}
				if(!err) {
					var previous = lastListFetch ? listedRevisions : null;
					listedRevisions = Object.create(null);
					$tw.utils.each(tiddlers,function(fields) {
						if(fields.revision !== undefined && fields.revision !== null) {
							listedRevisions[fields.title] = String(fields.revision);
						}
					});
					lastListFetch = Date.now();
					listRequested = requested;
					$tw.utils.each(listListeners,function(listener) {
						try {
							listener(listedRevisions,previous,tiddlers);
						} catch(e) {
							console.error("cfworker: a tiddler list listener failed:",e);
						}
					});
				}
				return callback(err,tiddlers);
			}
		}
		fetchList();
	};

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

	// listener(listed, previous, entries) at each new tiddler list: listed and previous are title ->
	// revision (previous: the list before, null for the first), entries the list's tiddlers (fields)
	proto.cfworkerOnList = function(listener) {
		listListeners.push(listener);
	};

	// hook: {headers(adaptor): headers to add to the next list request, or null for none this time;
	// answer(xhr): called with the request once answered, when headers were added}
	proto.cfworkerOnListRequest = function(hook) {
		requestHooks.push(hook);
	};

	// A revision this tab now knows the worker has (a save of its own): what the next read from the
	// public site expects, until the next list
	proto.cfworkerNoteListed = function(title,revision) {
		listedRevisions[title] = revision;
	};

	// Fetch a tiddler from the public copy of the wiki (R2 + Cloudflare's cache, no worker request).
	// Only accepted if it is exactly the revision the worker listed; callback(fields) or callback(null).
	var PUBLIC_READ_TIMEOUT = 5000;
	function loadFromPublicSite(adaptor,title,callback) {
		var expected = listedRevisions[title];
		function done(fields) {
			setTimeout(function() {
				callback(fields);
			},0);
		}
		if(!publicBase || lib.siteOf(publicBase) === lib.siteOf(adaptor.host) || !expected || typeof fetch !== "function") {
			return done(null);
		}
		// A public site that doesn't answer (rather than fails) mustn't hold up loading: given up after a
		// few seconds, and the text comes from the worker
		var controller = typeof AbortController === "function" ? new AbortController() : null,
			timer = controller && setTimeout(function() {
				controller.abort();
			},PUBLIC_READ_TIMEOUT);
		fetch(publicBase + "recipes/default/tiddlers/" + encodeURIComponent(title),{cache: "no-cache", credentials: "omit", signal: controller ? controller.signal : undefined})
			.then(function(response) {
				return response.ok ? response.json() : null;
			})
			.then(function(data) {
				clearTimeout(timer);
				var fields = null;
				try {
					if(data && data.title === title && data.revision !== undefined && data.revision !== null && String(data.revision) === expected) {
						fields = adaptor.convertTiddlerFromTiddlyWebFormat(data);
					}
				} catch(e) {
					fields = null;
				}
				done(fields);
			},function() {
				clearTimeout(timer);
				done(null);
			});
	}

	// Never let a background reload overwrite local changes that haven't been uploaded yet;
	// the pending save will detect any conflict instead
	proto.loadTiddler = function(title,callback) {
		var self = this;
		if(hasUnsavedChanges(title)) {
			return callback(null,null);
		}
		function finish(err,tiddlerFields) {
			if(!err && tiddlerFields && hasUnsavedChanges(title)) {
				return callback(null,null);
			}
			callback(err,tiddlerFields);
		}
		loadFromPublicSite(this,title,function(tiddlerFields) {
			if(tiddlerFields) {
				finish(null,tiddlerFields);
			} else {
				originalLoadTiddler.call(self,title,finish);
			}
		});
	};
};

})();
