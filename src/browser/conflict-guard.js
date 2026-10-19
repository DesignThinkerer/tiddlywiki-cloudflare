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

And it sends saves in the layout the worker stores (X-Tiddler-Layout: flat): every field at the
top level, compact JSON, "text" last, no revision/bag/recipe. The worker then only parses the
fields before "text" and never has to decode or re-encode the text itself, however big it is.

The rest of the tab's syncing with the worker (the tiddler list, reads, what isn't sent) is
$:/cfworker/list-sync.js.
\*/
(function(){

"use strict";

exports.name = "cfworker-conflict-guard";
exports.platforms = ["browser"];
exports.after = ["load-modules"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

// Fields that don't count as "content" when deciding whether two versions really differ
var BOOKKEEPING_FIELDS = ["revision","bag","recipe","permissions","modified","modifier"];

// ms before a save or delete answered "rebuilding" is sent again (through lib.wait: the tests scale it)
var REBUILDING_RETRY = 1000;

// The body of a save in the worker's "flat" layout, the only one it stores; the worker appends its
// own revision, bag and recipe. A field called "fields" stays nested as {fields: value}, the way
// TiddlyWeb's layout has it: a flat "fields" is where TiddlyWeb's loader looks for nested fields.
function flatBody(tiddler) {
	var result = {},
		fields = tiddler.fields;
	$tw.utils.each(fields,function(value,name) {
		if(name === "fields") {
			result.fields = {fields: tiddler.getFieldString(name)};
		} else if(name !== "text" && name !== "revision" && name !== "bag" && name !== "recipe") {
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
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || Adaptor.prototype.conflictGuardInstalled) {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		// Base revisions. A string is the server revision the content was derived from, null means
		// "must not exist on the server yet", undefined means unknown (the save is sent unconditionally).
		draftBases = Object.create(null),   // draft title -> {of: title, base: revision}
		pendingBases = Object.create(null), // title -> {base: revision} for a confirmed draft not yet uploaded
		deleteBases = Object.create(null),  // title -> revision its editor started from, for the delete a rename or a delete from the editor makes
		unconfirmedSaves = Object.create(null); // title -> the tiddler of a save that got an error: the worker may have stored it all the same
	proto.conflictGuardInstalled = true;

	// The revision a save is based on, from a tiddler's revision: undefined if it has none (the save
	// is sent without a condition), null if it's one the worker never gives, which means the worker
	// doesn't have that version. The worker's revisions are times in milliseconds (or an R2 etag for
	// a tiddler stored by hand); the tiddlers that came with the page carry "0" in a published page,
	// or a change count in index.html (as the page publisher's hasStoredRevision tells them apart).
	// Saving one, a plugin updated from the library say, then creates it on the worker, and is a
	// conflict only if another tab stored it meanwhile, instead of being taken for a tiddler that
	// was deleted.
	function revisionBase(revision) {
		if(revision === undefined || revision === null || revision === "") {
			return undefined;
		}
		revision = String(revision);
		return /^\d{1,9}$/.test(revision) ? null : revision;
	}

	function baseFromInfo(info) {
		if(!info) {
			return null;
		}
		return revisionBase(info.revision);
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
		if(deleteBases[title] === oldBase) {
			deleteBases[title] = newBase;
		}
	}

	// (A tiddler without a type, as one created in this tab, has the default one the browser module
	// sends: the server's copy of it has that type)
	function sameContent(localTiddler,serverFields) {
		if(!serverFields) {
			return false;
		}
		var local = localTiddler.fields.type ? localTiddler : new $tw.Tiddler(localTiddler,{type: "text/vnd.tiddlywiki"}),
			server = new $tw.Tiddler(serverFields);
		if(!server.fields.type) {
			server = new $tw.Tiddler(server,{type: "text/vnd.tiddlywiki"});
		}
		return local.isEqual(server,BOOKKEEPING_FIELDS);
	}

	// The title, shortened (ending with "…") if need be so that with suffix, and a number
	// generateNewTitle may add, it's still a title the worker stores
	function shortenedFor(title,suffix) {
		var room = lib.MAX_TITLE_BYTES - lib.utf8Length(suffix) - 8;
		if(lib.utf8Length(title) <= room) {
			return title;
		}
		var chars = Array.from(title);   // (whole characters: a pair of surrogates isn't split)
		while(chars.length && lib.utf8Length(chars.join("")) > room - 3) {
			chars.length -= Math.max(1,Math.floor((lib.utf8Length(chars.join("")) - room) / 4));
		}
		return chars.join("") + "…";
	}

	function makeConflictCopy(localTiddler) {
		var title = localTiddler.fields.title,
			stamp = $tw.utils.formatDateString(new Date(),"YYYY-0MM-0DD 0hh.0mm.0ss"),
			copyTitle = wiki.generateNewTitle(shortenedFor(title," (conflict " + stamp + ")") + " (conflict " + stamp + ")"),
			keptTags = [],
			removedTags = [];
		// Keep the copy inert: system tags such as $:/tags/Stylesheet or $:/tags/Macro would make it take
		// effect (every $:/ tag: TiddlyWiki's older $:/core/wiki/rawmarkup still puts raw markup in the
		// page), and so would module-type (a JavaScript module, defined and run at startup) or plugin-type
		// (a plugin, whose contents would even override the original's). They're moved aside, kept for
		// putting back by hand.
		$tw.utils.each(localTiddler.fields.tags || [],function(tag) {
			(tag.indexOf("$:/") === 0 ? removedTags : keptTags).push(tag);
		});
		var fields = {
			title: copyTitle,
			tags: keptTags,
			revision: undefined,
			bag: undefined,
			recipe: undefined,
			permissions: undefined,
			"conflict-of": title,
			"conflict-removed-tags": removedTags.length ? $tw.utils.stringifyList(removedTags) : undefined
		};
		$tw.utils.each(["module-type","plugin-type"],function(field) {
			if(localTiddler.fields[field] !== undefined) {
				fields[field] = undefined;
				fields["conflict-removed-" + field] = localTiddler.fields[field];
			}
		});
		wiki.addTiddler(new $tw.Tiddler(localTiddler,fields));
		if($tw.Story) {
			new $tw.Story({wiki: wiki}).addToStory(copyTitle,title);
		}
		return copyTitle;
	}

	// For a copy of code (see makeConflictCopy): it doesn't run, and how to use that version
	// deleted: the original was deleted elsewhere, so there's nothing to copy the text into
	function inactiveNote(localTiddler,title,deleted) {
		var moved = ["module-type","plugin-type"].filter(function(field) {
			return localTiddler.fields[field] !== undefined;
		});
		if(!moved.length) {
			return "";
		}
		var note = " The copy is inactive (its " + moved.join(" and ") + " moved to " + moved.map(function(field) {
			return "conflict-removed-" + field;
		}).join(" and ") + "): to use your version, ";
		return note + (deleted ? "rename it " + lib.link(title) + " and give it back its " + moved.join(" and ") + "." : "copy its text into " + lib.link(title) + ".");
	}

	// The server rejected our write because its copy changed. Keep our version, adopt the server's.
	// ownEarlier(revision): for a save, called instead if the server's copy is this tab's own earlier
	// save, one that got an error (an answer lost, say) though the worker stored it
	// The server's version, adopted here: stored as a load is, and kept on the device at that revision
	// as a save of this tab's would be (the list sync), so a later load of it costs nothing. Before,
	// only the wiki got it: the device kept this tab's refused version, and the next page load fetched
	// the tiddler again.
	function adoptServer(title,serverFields) {
		$tw.syncer.storeTiddler(serverFields);
		if(typeof proto.cfworkerNoteListed === "function" && serverFields.revision !== undefined && serverFields.revision !== null) {
			proto.cfworkerNoteListed(title,String(serverFields.revision),wiki.getTiddler(title));
		}
	}
	function resolveConflict(adaptor,title,operation,callback,ownEarlier) {
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
				var localTiddler = wiki.tiddlerExists(title) && wiki.getTiddler(title),
					earlier = unconfirmedSaves[title];
				if(operation === "save" && ownEarlier && earlier && serverFields && sameContent(earlier,serverFields)) {
					delete unconfirmedSaves[title];
					return ownEarlier(serverFields.revision);
				}
				// (Only now that the server's answer is in: if asking failed, the syncer tries the save
				// or delete again, which must still be based on the same revision)
				delete pendingBases[title];
				if(operation === "delete") {
					delete deleteBases[title];
					if(!serverFields) {
						return callback(null,null); // It has been deleted in the meantime anyway
					}
					adoptServer(title,serverFields);
					return callback("Delete conflict: " + lib.link(title) + " was changed in another tab or browser, so it was not deleted. The latest version has been restored.");
				}
				if(localTiddler && sameContent(localTiddler,serverFields)) {
					// Someone else saved exactly what we were saving: nothing to keep
					adoptServer(title,serverFields);
					callback(null,{bag: serverFields.bag || "default"},serverFields.revision);
					if(s.tiddlerInfo[title]) {
						s.tiddlerInfo[title].changeCount = wiki.getChangeCount(title);
					}
					return;
				}
				var copyTitle = localTiddler ? makeConflictCopy(localTiddler) : null,
					kept = copyTitle ? " Your version has been kept as " + lib.link(copyTitle) + "." + inactiveNote(localTiddler,title,!serverFields) : "";
				if(serverFields) {
					adoptServer(title,serverFields);
					callback("Edit conflict: " + lib.link(title) + " was changed in another tab or browser before your save reached the server." + kept + " " + lib.link(title) + " now shows the server version.");
				} else {
					delete s.tiddlerInfo[title];
					if(localTiddler) {
						wiki.deleteTiddler(title);
					}
					callback("Edit conflict: " + lib.link(title) + " was deleted in another tab or browser." + kept);
				}
			}
		});
	}

	// Drafts are never saved to the server (the list sync keeps them out of syncing), so TiddlyWiki's
	// syncer doesn't count an open editor as unsaved, and wouldn't warn before the tab closes or
	// reloads. The browser asks here instead, if an editor holds changes. The outbox keeps the draft
	// on the device meanwhile (design 1.10), a moment behind the typing and only if the device takes
	// it: the dialog is the belt over those two cases (design 2.7).
	window.addEventListener("beforeunload",function(event) {
		var typing = wiki.filterTiddlers("[is[draft]]").some(function(title) {
			return wiki.isDraftModified(title);
		});
		if(typing) {
			var message = $tw.language.getString("UnsavedChangesWarning");
			event.preventDefault();
			event.returnValue = message;
			return message;
		}
	});

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
			// There again (restored, or made again before the delete went out): nothing to delete
			delete deleteBases[title];
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
				base = revisionBase(draft.fields.revision);
			}
			draftBases[title] = {of: of, base: base};
		});
	});

	// When a draft is confirmed, the saved tiddler inherits the draft's base revision. A rename then
	// deletes the old title: that delete is from the version the editor started from too, so it's
	// refused (a delete conflict) if another tab saved a newer one meanwhile, which this tab may even
	// have loaded behind the editor
	$tw.hooks.addHook("th-saving-tiddler",function(newTiddler,draftTiddler) {
		if(newTiddler && draftTiddler) {
			var record = draftBases[draftTiddler.fields.title];
			if(record && record.of === newTiddler.fields.title) {
				pendingBases[record.of] = {base: record.base};
			} else if(record && typeof record.base === "string") {
				deleteBases[record.of] = record.base;
			}
		}
		return newTiddler;
	});

	// Deleting from an open editor deletes the tiddler too: the same applies
	$tw.hooks.addHook("th-deleting-tiddler",function(tiddler) {
		var title = tiddler && tiddler.fields.title;
		$tw.utils.each(draftBases,function(record) {
			if(title && record.of === title && typeof record.base === "string") {
				deleteBases[title] = record.base;
			}
		});
		return tiddler;
	});

	// A change kept on the device ($:/cfworker/outbox.js), made from this server revision, put back
	// into the wiki: the next save or delete of this title is based on it, not on what the list
	// says now, so a version saved elsewhere meanwhile is a conflict, as it would have been. The
	// outbox keeps null for a tiddler the worker never had: the save then says it mustn't exist yet
	// (If-None-Match: *), as the tab that made the change would have, so a title created elsewhere
	// meanwhile is a conflict too. (revisionBase takes null for "unknown", which would send the save
	// unconditionally, over whatever is there.)
	// A draft's base, as recorded when it was made here (undefined for a draft this tab doesn't know),
	// and the same told by another tab or the device, before the draft tiddler arrives (the change
	// listener above then leaves it): the outbox carries it with a draft (design 1.16), since the
	// draft's own revision field is TiddlyWiki's copy of its tiddler's, stale after this tab's own save
	proto.cfworkerDraftBase = function(draftTitle) {
		return draftBases[draftTitle] ? draftBases[draftTitle].base : undefined;
	};
	proto.cfworkerDraftBaseFor = function(draftTitle,of,base) {
		draftBases[draftTitle] = {of: of, base: base};
	};
	proto.cfworkerBaseFor = function(title,revision) {
		var base = revision === null ? null : revisionBase(revision);
		pendingBases[title] = {base: base};
		if(typeof base === "string") {
			deleteBases[title] = base;
		}
	};

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
			tries = 0;
		function send() {
			// (The headers made afresh for each try: a retry based on the stored version, after a first
			// try whose answer was lost, must not keep the first one's "must not exist")
			$tw.utils.httpRequest({
				url: self.host + "recipes/" + encodeURIComponent(self.recipe) + "/tiddlers/" + encodeURIComponent(title),
				type: "PUT",
				headers: addPreconditions({"Content-type": "application/json", "X-Tiddler-Layout": "flat"},title,base,info),
				data: body,
				callback: function(err,data,request) {
					if(err) {
						if(lib.isRebuilding(request) && ++tries <= lib.REBUILD_RETRIES) {
							return setTimeout(send,lib.wait(REBUILDING_RETRY));
						}
						if(request && request.status === 412) {
							return resolveConflict(self,title,"save",callback,function(revision) {
								// The worker has this tab's earlier save: this one is based on it. (Its
								// editors move on to it too.)
								rebase(title,base,revision);
								base = revision;
								send();
							});
						}
						// Maybe stored all the same: the next try's refusal will tell (resolveConflict)
						unconfirmedSaves[title] = tiddler;
						return callback(err);
					}
					delete unconfirmedSaves[title];
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
					// The list sync keeps the saved version (a public copy from before the save
					// doesn't count): the next read expects this revision, and has it on the device
					if(self.cfworkerNoteListed) {
						self.cfworkerNoteListed(title,etagInfo.revision,tiddler);
					}
					// Saved before its text had loaded (the worker kept the stored text): load it now,
					// the version just saved
					if(tiddler.hasField("_is_skinny") && s) {
						setTimeout(function() {
							s.enqueueLoadTiddler(title);
						},0);
					}
				}
			});
		}
		send();
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
			delete deleteBases[title];
			return callback(null,info && info.adaptorInfo);
		}
		var tries = 0,
			base = title in deleteBases ? deleteBases[title] : (baseFromInfo(info) || undefined);
		function send() {
			$tw.utils.httpRequest({
				url: self.host + "bags/" + encodeURIComponent(bag) + "/tiddlers/" + encodeURIComponent(title),
				type: "DELETE",
				headers: addPreconditions({},title,base,info),
				callback: function(err,data,request) {
					if(err) {
						if(lib.isRebuilding(request) && ++tries <= lib.REBUILD_RETRIES) {
							return setTimeout(send,lib.wait(REBUILDING_RETRY));
						}
						if(request && request.status === 412) {
							return resolveConflict(self,title,"delete",callback);
						}
						return callback(err);
					}
					delete pendingBases[title];
					delete deleteBases[title];
					if(self.cfworkerNoteDeleted) {
						self.cfworkerNoteDeleted(title);
					}
					callback(null,null);
				}
			});
		}
		send();
	};
};

})();
