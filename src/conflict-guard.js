/*\
title: $:/cfworker/conflict-guard.js
type: application/javascript
module-type: startup

Edit-conflict protection for the TiddlyWeb sync adaptor (served by the Cloudflare worker).

- Every save says which server revision it is based on (If-Match), or If-None-Match: * for a new tiddler.
- A draft remembers the revision it was opened from, so an edit started before another tab saved
  is still caught even if this tab has re-synced in the meantime.
- When the server answers 412, your version is kept as "<title> (conflict <date>)", the server
  version is loaded, and an alert explains what happened. Deletes are protected the same way.

It also keeps worker requests down:
- Tiddler contents are fetched from the public copy of the wiki ($:/cfworker/public-url, served by
  R2/Cloudflare without the worker) when it holds exactly the revision the worker listed;
  otherwise from the worker as usual.
- Drafts and $:/StoryList, which the worker never stores, are not sent to it, and the "put" saver
  no longer probes the page URL on every load.
- Background tabs stop polling for changes and catch up as soon as they are shown again.

And it sends saves in the layout the worker stores (X-Tiddler-Layout: flat): every field at the
top level, compact JSON, "text" last, no revision/bag/recipe. The worker then only parses the
fields before "text" and never has to decode or re-encode the text itself, however big it is.
\*/
(function(){

"use strict";

exports.name = "cfworker-conflict-guard";
exports.platforms = ["browser"];
exports.after = ["load-modules"];
exports.before = ["startup"];
exports.synchronous = true;

// Fields that don't count as "content" when deciding whether two versions really differ
var BOOKKEEPING_FIELDS = ["revision","bag","recipe","permissions","modified","modifier"];

function link(title) {
	return (title.indexOf("]]") === -1 && title.indexOf("|") === -1) ? "[[" + title + "]]" : "'" + title + "'";
}

// The body of a save in the worker's "flat" layout; the worker appends its own revision, bag and
// recipe. Returns null for a tiddler with a field called "fields", which this layout can't
// represent (TiddlyWeb's loader would take it for its nested field list).
function flatBody(tiddler) {
	var result = {},
		fields = tiddler.fields;
	if($tw.utils.hop(fields,"fields")) {
		return null;
	}
	$tw.utils.each(fields,function(value,name) {
		if(name !== "text" && name !== "revision" && name !== "bag" && name !== "recipe") {
			result[name] = name === "tags" ? value : tiddler.getFieldString(name);
		}
	});
	result.type = result.type || "text/vnd.tiddlywiki";
	if(fields.text !== undefined) {
		result.text = tiddler.getFieldString("text");
	}
	return JSON.stringify(result);
}

exports.startup = function() {
	var Adaptor = null;
	$tw.modules.forEachModuleOfType("syncadaptor",function(title,module) {
		if(module.adaptorClass && module.adaptorClass.prototype.name === "tiddlyweb") {
			Adaptor = module.adaptorClass;
		}
	});
	if(!Adaptor || Adaptor.prototype.conflictGuardInstalled) {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		originalLoadTiddler = proto.loadTiddler,
		originalGetSkinnyTiddlers = proto.getSkinnyTiddlers,
		publicBase = (wiki.getTiddlerText("$:/cfworker/public-url","") || "").trim(),
		listedRevisions = Object.create(null), // title -> revision in the worker's latest tiddler list
		lastListFetch = 0,
		// Base revisions. A string is the server revision the content was derived from, null means
		// "must not exist on the server yet", undefined means unknown (the save is sent unconditionally).
		draftBases = Object.create(null),   // draft title -> {of: title, base: revision}
		pendingBases = Object.create(null); // title -> {base: revision} for a confirmed draft not yet uploaded
	proto.conflictGuardInstalled = true;

	if(publicBase && publicBase.charAt(publicBase.length - 1) !== "/") {
		publicBase += "/";
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

	if($tw.Syncer && !$tw.Syncer.prototype.cfworkerPatched) {
		var originalGetSyncedTiddlers = $tw.Syncer.prototype.getSyncedTiddlers,
			originalChooseNextTask = $tw.Syncer.prototype.chooseNextTask;
		$tw.Syncer.prototype.cfworkerPatched = true;
		// Keep drafts and the story list out of syncing: the worker never stores them. For drafts it
		// also matters because after the next poll the syncer would see them as "missing from the
		// server" and delete the open draft, closing the editor.
		$tw.Syncer.prototype.getSyncedTiddlers = function(source) {
			var syncerWiki = this.wiki;
			return originalGetSyncedTiddlers.call(this,source).filter(function(title) {
				var tiddler = syncerWiki.getTiddler(title);
				return title !== "$:/StoryList" && !(tiddler && tiddler.fields["draft.of"]);
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
			if(!document.hidden && s && s.syncadaptor && s.syncadaptor.conflictGuardInstalled && Date.now() - lastListFetch > 10000) {
				s.syncFromServer();
			}
		});
	}

	function baseFromInfo(info) {
		if(!info) {
			return null;
		}
		var revision = info.revision;
		return (revision === undefined || revision === null || revision === "") ? undefined : String(revision);
	}

	function currentBase(title) {
		if(pendingBases[title]) {
			return pendingBases[title].base;
		}
		var s = $tw.syncer;
		return baseFromInfo(s && s.tiddlerInfo[title]);
	}

	function addPreconditions(headers,title,base,info) {
		if(typeof base === "string") {
			var bag = (info && info.adaptorInfo && info.adaptorInfo.bag) || "default";
			headers["If-Match"] = "\"" + bag + "/" + encodeURIComponent(title) + "/" + base + ":auto\"";
		} else if(base === null) {
			headers["If-None-Match"] = "*";
		}
		return headers;
	}

	// After our own successful write, anything based on the old revision is now based on the new one
	function rebase(title,oldBase,newBase) {
		$tw.utils.each(draftBases,function(record) {
			if(record.of === title && record.base === oldBase) {
				record.base = newBase;
			}
		});
		if(pendingBases[title] && pendingBases[title].base === oldBase) {
			pendingBases[title].base = newBase;
		}
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

	function sameContent(localTiddler,serverFields) {
		return !!serverFields && localTiddler.isEqual(new $tw.Tiddler(serverFields),BOOKKEEPING_FIELDS);
	}

	function makeConflictCopy(localTiddler) {
		var title = localTiddler.fields.title,
			stamp = $tw.utils.formatDateString(new Date(),"YYYY-0MM-0DD 0hh.0mm.0ss"),
			copyTitle = wiki.generateNewTitle(title + " (conflict " + stamp + ")"),
			keptTags = [],
			removedTags = [];
		// Keep the copy inert: tags such as $:/tags/Stylesheet or $:/tags/Macro would make it take effect
		$tw.utils.each(localTiddler.fields.tags || [],function(tag) {
			(tag.indexOf("$:/tags/") === 0 ? removedTags : keptTags).push(tag);
		});
		wiki.addTiddler(new $tw.Tiddler(localTiddler,{
			title: copyTitle,
			tags: keptTags,
			revision: undefined,
			bag: undefined,
			recipe: undefined,
			permissions: undefined,
			"conflict-of": title,
			"conflict-removed-tags": removedTags.length ? $tw.utils.stringifyList(removedTags) : undefined
		}));
		if($tw.Story) {
			new $tw.Story({wiki: wiki}).addToStory(copyTitle,title);
		}
		return copyTitle;
	}

	// The server rejected our write because its copy changed. Keep our version, adopt the server's.
	function resolveConflict(adaptor,title,operation,callback) {
		$tw.utils.httpRequest({
			url: adaptor.host + "recipes/" + encodeURIComponent(adaptor.recipe) + "/tiddlers/" + encodeURIComponent(title),
			callback: function(err,data,request) {
				var serverFields = null,
					s = $tw.syncer;
				if(err) {
					if(!request || request.status !== 404) {
						return callback(err); // The syncer will retry, and we'll get here again
					}
				} else {
					try {
						serverFields = adaptor.convertTiddlerFromTiddlyWebFormat(JSON.parse(data));
					} catch(e) {
						return callback("Could not read the server copy of '" + title + "': " + e);
					}
				}
				var localTiddler = wiki.tiddlerExists(title) && wiki.getTiddler(title);
				delete pendingBases[title];
				if(operation === "delete") {
					if(!serverFields) {
						return callback(null,null); // It has been deleted in the meantime anyway
					}
					s.storeTiddler(serverFields);
					return callback("Delete conflict: " + link(title) + " was changed in another tab or browser, so it was not deleted. The latest version has been restored.");
				}
				if(localTiddler && sameContent(localTiddler,serverFields)) {
					// Someone else saved exactly what we were saving: nothing to keep
					s.storeTiddler(serverFields);
					callback(null,{bag: serverFields.bag || "default"},serverFields.revision);
					if(s.tiddlerInfo[title]) {
						s.tiddlerInfo[title].changeCount = wiki.getChangeCount(title);
					}
					return;
				}
				var copyTitle = localTiddler ? makeConflictCopy(localTiddler) : null,
					kept = copyTitle ? " Your version has been kept as " + link(copyTitle) + "." : "";
				if(serverFields) {
					s.storeTiddler(serverFields);
					callback("Edit conflict: " + link(title) + " was changed in another tab or browser before your save reached the server." + kept + " " + link(title) + " now shows the server version.");
				} else {
					delete s.tiddlerInfo[title];
					if(localTiddler) {
						wiki.deleteTiddler(title);
					}
					callback("Edit conflict: " + link(title) + " was deleted in another tab or browser." + kept);
				}
			}
		});
	}

	// Remember which revision each draft was opened from
	wiki.addEventListener("change",function(changes) {
		$tw.utils.each(changes,function(change,title) {
			if(change.deleted) {
				delete draftBases[title];
				if(!wiki.tiddlerExists(title)) {
					delete pendingBases[title];
				}
				return;
			}
			if(draftBases[title]) {
				return;
			}
			var draft = wiki.getTiddler(title),
				of = draft && draft.fields["draft.of"];
			if(!of) {
				return;
			}
			var original = wiki.getTiddler(of),
				base = currentBase(of);
			// If the original was reloaded from the server between the draft being made and now,
			// the draft still carries the older revision it was copied from
			if(original && draft.fields.revision !== undefined && original.fields.revision !== draft.fields.revision) {
				base = String(draft.fields.revision);
			}
			draftBases[title] = {of: of, base: base};
		});
	});

	// When a draft is confirmed, the saved tiddler inherits the draft's base revision
	$tw.hooks.addHook("th-saving-tiddler",function(newTiddler,draftTiddler) {
		if(newTiddler && draftTiddler) {
			var record = draftBases[draftTiddler.fields.title];
			if(record && record.of === newTiddler.fields.title) {
				pendingBases[record.of] = {base: record.base};
			}
		}
		return newTiddler;
	});

	proto.saveTiddler = function(tiddler,callback,options) {
		var self = this,
			title = tiddler.fields.title,
			s = $tw.syncer,
			info = (options && options.tiddlerInfo) || (s && s.tiddlerInfo[title]),
			pending = pendingBases[title],
			base = pending ? pending.base : baseFromInfo(info);
		if(this.isReadOnly) {
			return callback(null);
		}
		var body = flatBody(tiddler),
			headers = {"Content-type": "application/json"};
		if(body === null) {
			body = this.convertTiddlerToTiddlyWebFormat(tiddler);
		} else {
			headers["X-Tiddler-Layout"] = "flat";
		}
		$tw.utils.httpRequest({
			url: this.host + "recipes/" + encodeURIComponent(this.recipe) + "/tiddlers/" + encodeURIComponent(title),
			type: "PUT",
			headers: addPreconditions(headers,title,base,info),
			data: body,
			callback: function(err,data,request) {
				if(err) {
					if(request && request.status === 412) {
						return resolveConflict(self,title,"save",callback);
					}
					return callback(err);
				}
				if($tw.browserStorage && $tw.browserStorage.isEnabled()) {
					$tw.browserStorage.removeTiddlerFromLocalStorage(title);
				}
				var etag = request.getResponseHeader("Etag"),
					etagInfo = etag && self.parseEtag(etag);
				if(!etagInfo) {
					return callback("Response from server is missing required ETag header");
				}
				if(pending && pendingBases[title] === pending) {
					delete pendingBases[title];
				}
				rebase(title,base,etagInfo.revision);
				callback(null,{bag: etagInfo.bag},etagInfo.revision);
			}
		});
	};

	proto.deleteTiddler = function(title,callback,options) {
		var self = this,
			info = options && options.tiddlerInfo,
			bag = info && info.adaptorInfo && info.adaptorInfo.bag;
		if(this.isReadOnly) {
			return callback(null);
		}
		// No bag means the server has never seen this tiddler, so there is nothing to delete
		if(!bag) {
			return callback(null,info && info.adaptorInfo);
		}
		$tw.utils.httpRequest({
			url: this.host + "bags/" + encodeURIComponent(bag) + "/tiddlers/" + encodeURIComponent(title),
			type: "DELETE",
			headers: addPreconditions({},title,baseFromInfo(info) || undefined,info),
			callback: function(err,data,request) {
				if(err) {
					if(request && request.status === 412) {
						return resolveConflict(self,title,"delete",callback);
					}
					return callback(err);
				}
				delete pendingBases[title];
				callback(null,null);
			}
		});
	};

	// Remember which revision the worker currently lists for each tiddler
	proto.getSkinnyTiddlers = function(callback) {
		return originalGetSkinnyTiddlers.call(this,function(err,tiddlers) {
			if(!err && $tw.utils.isArray(tiddlers)) {
				listedRevisions = Object.create(null);
				$tw.utils.each(tiddlers,function(fields) {
					if(fields && typeof fields.title === "string" && fields.revision !== undefined && fields.revision !== null) {
						listedRevisions[fields.title] = String(fields.revision);
					}
				});
				lastListFetch = Date.now();
			}
			return callback.apply(this,arguments);
		});
	};

	// Fetch a tiddler from the public copy of the wiki (R2 + Cloudflare's cache, no worker request).
	// Only accepted if it is exactly the revision the worker listed; callback(fields) or callback(null).
	function loadFromPublicSite(adaptor,title,callback) {
		var expected = listedRevisions[title];
		function done(fields) {
			setTimeout(function() {
				callback(fields);
			},0);
		}
		if(!publicBase || publicBase === adaptor.host || !expected || typeof fetch !== "function") {
			return done(null);
		}
		fetch(publicBase + "recipes/default/tiddlers/" + encodeURIComponent(title),{cache: "no-cache", credentials: "omit"})
			.then(function(response) {
				return response.ok ? response.json() : null;
			})
			.then(function(data) {
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
