/*\
title: $:/cfworker/page-publisher.js
type: application/javascript
module-type: startup

Publishes the page from the admin wiki (served by the Cloudflare worker), the way TiddlyWiki writes
its own file, but with the core in a separate file:

- The shell: TiddlyWiki's own $:/core/templates/tiddlywiki5-external-js.html, with the tiddlers that
  came with the page (the themes, TiddlyWeb: plugins the worker doesn't store), installed plugins that
  have raw markup, and your raw markup tiddlers; never one that was deleted, here or in another tab.
  TiddlyWiki writes everything else: the title, the language, the raw markup, the content for
  browsers without JavaScript. The core is loaded at the end, from the public site (from the worker,
  at a root-relative URL, in a private wiki).
- The core file: TiddlyWiki's own $:/core/templates/tiddlywiki5.js (boot code, library modules,
  $:/core), sent once per TiddlyWiki version.

The worker keeps them and builds the page from them, for both sites. The shell is rendered afresh
for each check and compared with the published one by a fingerprint. (Not kept rendered and
refreshed: raw markup is wikified apart from the widget tree, so TiddlyWiki's refresh wouldn't see a
change to a tiddler it transcludes, like $:/SiteTitle in the Open Graph tags.) It's published:
- a moment after this tab saves or deletes something, if the page it renders is no longer the one
  published: first in sync with the worker, so a change another tab saved before is included;
- when the admin wiki loads, once synced, if it renders something else than the page it loaded
  (the first load after a new index.html, a failed publish, a change made outside the admin wiki).
Changes that arrive from other tabs aren't published by this one: their tab does it. But this tab
then no longer knows which page is published, so its next check sends its page even if it's the one
it published (or loaded) before: a change undone here, say. The same after a failure. Nothing is sent
while a tiddler the page needs is still loading, or in safe mode (#:safe). A failure (also an error
while preparing the page) is shown in a notification and tried again at the next save or load; a
page the worker refused (400, 409) only once it changes, or at the next load, and after a refused
core file, only at the next load. One refusal is different: the shell says which stored shell the
page it replaces was built from (X-Page-Shell, from the page source, then from each answer), and a
page built before another tab published is refused with the current version: this tab then syncs,
so it has that tab's change, and sends its page again.
\*/
"use strict";

exports.name = "cfworker-page-publisher";
exports.platforms = ["browser"];
exports.after = ["rootwidget"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

var TEMPLATE = "$:/core/templates/tiddlywiki5-external-js.html",
	CORE_TEMPLATE = "$:/core/templates/tiddlywiki5.js",
	CORE_FORMAT = "1",   // changes when the core file is rendered differently: a new URL for it
	SOURCE = "$:/cfworker/page-source",
	STATUS = "$:/temp/cfworker/page-publisher",
	RAW_MARKUP_TAGS = [
		"$:/core/wiki/rawmarkup", "$:/tags/RawMarkup", "$:/tags/RawMarkupWikified",
		"$:/tags/RawMarkupWikified/TopHead", "$:/tags/RawMarkupWikified/TopBody", "$:/tags/RawMarkupWikified/BottomBody"
	],
	PAUSE = 1000,          // after a save, so a burst of saves is published once ($:/config/cfworker/PublishPause, the plugin's settings)
	LIST_SETTLE = 1000,    // after a tiddler list, before anything here counts as quiet: the page renders, and asks, first
	QUIET_POLL = 200,      // between looks while waiting for that
	START_POLL = 300,      // between looks for the first tiddler list
	QUIET_TIMEOUT = 60000; // waiting for saves and loads to finish, at most (a ceiling in real time, the tests' too)
// (The waits go through lib.wait: the tests scale them, a deployed wiki has them as they are; the
// ceiling is the sum of the polls as they were waited, so it isn't)

// TiddlyWiki's page template, as its save templates use it (with the global macros). One change: the
// TiddlyWeb plugin writes each stored tiddler's "revision" as its changecount, a count of this tab's
// changes, which differs from tab to tab; here it's the tiddler's revision, the worker's, so the same
// wiki gives the same page in every tab, and a page load doesn't take its tiddlers for changed ones.
var SHELL_TEXT = "\\import [subfilter{$:/core/config/GlobalImportFilter}]\n" +
	"\\function changecount() [<currentTiddler>get[revision]else[0]]\n" +
	"{{" + TEMPLATE + "}}\n";

// TiddlyWiki's line in its core file that switches the save template to the external-core one: it
// would turn TiddlyWeb's "Save snapshot for offline use" into snapshots that need the core file
var SNAPSHOT_SETTING = /\$tw\.preloadTiddlerArray\(\[\{\s*title: "\$:\/config\/SaveWikiButton\/Template",[^\]]*\}\]\);\n?/;

function fingerprint(text) {
	var hash = 5381;
	for(var i = 0; i < text.length; i++) {
		hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
	}
	return text.length.toString(36) + "-" + hash.toString(36);
}

exports.startup = function() {
	var wiki = $tw.wiki,
		adaptor = $tw.syncadaptor,
		syncer = $tw.syncer,
		publicBase = lib.publicBase(),
		source = null;
	try {
		source = JSON.parse(wiki.getTiddlerText(SOURCE,"") || "null");
	} catch(e) {}
	// Only on the admin site, with the list sync ($:/cfworker/list-sync.js)
	if($tw.safeMode || !adaptor || !syncer || !source || !lib.onAdminSite(adaptor.host) || typeof adaptor.cfworkerListed !== "function") {
		return;
	}
	// The core file is loaded from the public site, or from this site (root-relative, the worker)
	// in a private wiki: the same URL the worker expects (page.js, coreFileUrl)
	var coreVersion = $tw.version + "-" + CORE_FORMAT,
		coreUrl = (publicBase || "/") + "_plugins/tiddlywikicore.js?v=" + encodeURIComponent(coreVersion),
		published = source.fingerprint || "",   // what the page this tab loaded was built from
		storedShell = source.shell || "",      // the stored shell it was built from, or this tab last published over (its version)
		storedCore = source.core || "",
		listGeneration = 0,                    // counts the lists that showed another tab's change (see cfworkerOnList)
		rebased = 0,                           // pages sent again in a row after another tab's publish
		refused = "",                          // the page (fingerprint and core version) the worker refused
		refusedCore = "",                      // the core file version the worker refused
		ownChanges = Object.create(null),      // title -> {stored: saved (true) or deleted (false), time, revision}
		cameWithPage = null,                   // title -> true, set once the first tiddler list has arrived
		started = false,
		timer = null,
		busy = false,
		again = false;

	// Whether the worker stores the tiddler: the latest tiddler list says, unless this tab saved or
	// deleted it after that list was requested
	function onServer(title,listed,since) {
		var own = ownChanges[title];
		if(own && own.time >= since) {
			return own.stored;
		}
		return $tw.utils.hop(listed,title);
	}

	// A revision the worker gave (tiddlers that came with the page have none, or "0" in a published
	// page, or a count of changes in a TiddlyWeb offline snapshot)
	function hasStoredRevision(title) {
		var tiddler = wiki.getTiddler(title),
			revision = tiddler && tiddler.fields.revision;
		return revision !== undefined && revision !== null && revision !== "" && !/^\d{1,9}$/.test(String(revision));
	}

	// The plugins and raw markup tiddlers in the page this tab loaded, before anything else happened:
	// those the worker doesn't store came with the page (from index.html: the themes, TiddlyWeb...).
	// Anything else not stored was deleted, here or in another tab: TiddlyWiki keeps $:/ tiddlers that
	// disappear from the server in tabs already open, and the page mustn't bring them back. (A copy of
	// a stored tiddler, left in the page by a publish that failed, isn't taken for one either.)
	function recordWhatCameWithPage(listed) {
		cameWithPage = Object.create(null);
		$tw.utils.each(candidates(),function(title) {
			if(!$tw.utils.hop(listed,title) && !(title in ownChanges) && !hasStoredRevision(title)) {
				cameWithPage[title] = true;
			}
		});
	}

	// Whether a plugin has raw markup the template would render: a tiddler of the plugin, as TiddlyWiki
	// has registered it, with a raw markup tag. (A plugin with JavaScript is only registered after a
	// reload; until then the template couldn't render its markup either.)
	function hasRawMarkup(title) {
		var info = wiki.getPluginInfo(title);
		return !!info && Object.keys(info.tiddlers || {}).some(function(shadow) {
			var tiddler = wiki.getTiddler(shadow);
			return !!tiddler && RAW_MARKUP_TAGS.some(function(tag) {
				return tiddler.hasTag(tag);
			});
		});
	}

	// The plugins (like TiddlyWiki's own save filters, without $:/temp/: its $:/temp/info-plugin, made at
	// each startup; and without pending imports) and the raw markup tiddlers, without drafts
	function plugins() {
		// (Not the admin plugin, the worker's own, which it puts in every page it builds)
		return wiki.filterTiddlers("[all[tiddlers]has[plugin-type]!is[draft]] -[[$:/core]] -[[$:/plugins/cfworker/admin]] -[prefix[$:/temp/]] -[prefix[$:/state/]] -[plugin-type[import]] -[has[plugin-type]field:platform[server]]");
	}
	function rawMarkupTiddlers() {
		var titles = [];
		$tw.utils.each(RAW_MARKUP_TAGS,function(tag) {
			$tw.utils.pushTop(titles,wiki.filterTiddlers("[all[tiddlers]tag[" + tag + "]!is[draft]]"));
		});
		return titles;
	}
	function candidates() {
		return plugins().concat(rawMarkupTiddlers());
	}

	// The shell's tiddlers:
	// - the plugins that came with the page, and stored plugins that have raw markup: the template only
	//   renders the markup of plugins in the page (they're still loaded as files too, which hold the
	//   same plugin). Other stored plugins are only files;
	// - the raw markup tiddlers, stored or that came with the page.
	// Nothing deleted, here or in another tab (see recordWhatCameWithPage).
	// Whether a tiddler not on the worker's list is still one that came with the page: recorded so at
	// the first list, and without a revision from the worker since. One stored since (updated from the
	// wiki, in any tab) carries one from its next load: once the list drops it, it's a deleted tiddler,
	// not one that came with the page, and stays out, whichever tab deleted it. (So checked at each
	// render, not only when the record was made.)
	function stillCameWithPage(title) {
		return !!(cameWithPage && cameWithPage[title]) && !hasStoredRevision(title);
	}
	function pageTitles() {
		var listed = adaptor.cfworkerListed() || {},
			since = adaptor.cfworkerListedSince ? adaptor.cfworkerListedSince() : 0,
			titles = plugins().filter(function(title) {
				return onServer(title,listed,since) ? hasRawMarkup(title) : stillCameWithPage(title);
			});
		$tw.utils.pushTop(titles,rawMarkupTiddlers().filter(function(title) {
			return onServer(title,listed,since) || stillCameWithPage(title);
		}));
		return titles.sort();
	}

	// The shell as this tab renders it now, the way TiddlyWiki renders its save templates
	function shell(titles) {
		var widget = wiki.makeWidget(wiki.parseText("text/vnd.tiddlywiki",SHELL_TEXT),{
				document: $tw.fakeDocument,
				variables: {
					saveTiddlerFilter: $tw.utils.stringifyList(titles || pageTitles()),
					coreURL: coreUrl
				}
			}),
			container = $tw.fakeDocument.createElement("div");
		widget.render(container,null);
		return container.textContent;
	}

	function report(state,text) {
		wiki.addTiddler({title: STATUS, type: "text/plain", state: state, text: text});
		if(state === "failed") {
			$tw.notifier.display(STATUS);
		}
	}

	// (The worker may have kept the page all the same, an answer lost on the way, say: which page is
	// published is no longer known)
	function failed(done,message) {
		published = "";
		report("failed","Page not published: " + message + " It will be tried again at the next save or reload.");
		done();
	}

	// Whether the page with this fingerprint needs nothing sent: it's the one published, or the worker
	// refused it (sent again only once it changes: the same page would be refused again), or this
	// TiddlyWiki's core file (no page can be published without it, until a reload)
	function settled(print) {
		return (print === published && storedCore === coreVersion) || print + " " + coreVersion === refused ||
			(refusedCore === coreVersion && storedCore !== coreVersion);
	}

	// A failed request: a refusal from the worker (400, or 409 when index.html changed) is final for
	// this page, or for this core file; anything else (5xx, no connection, signed out) may pass at the
	// next try
	function rejected(done,print,err,status,core) {
		if(status === 400 || status === 409) {
			if(core) {
				refusedCore = coreVersion;
			} else {
				refused = print + " " + coreVersion;
			}
			report("failed","Page not published: " + err + (core ? " It will be sent again at the next reload." : " It will be sent again once it changes, or at the next reload."));
			return done();
		}
		failed(done,err);
	}

	// Every step of a check runs through this: an error (in rendering the page, say: a raw markup
	// tiddler with a widget that can't render as text) is reported, and the tab can publish again
	// at its next save, instead of the check never finishing
	function guarded(done,step) {
		return function() {
			try {
				return step.apply(this,arguments);
			} catch(e) {
				console.error("cfworker page publisher:",e);
				failed(done,"an error while preparing it (" + (e && e.message || e) + ").");
			}
		};
	}

	// Whether nothing is being saved, and nothing the page needs is being loaded. The fill of the
	// other tiddlers (the list sync's, which says what's loading: cfworkerLoading) doesn't count: the
	// page doesn't render them. Nor is the first second after a tiddler list quiet: the page renders
	// what it shows then, and asks for its text, while the fill is held (list-sync.js), and the work
	// here (the shell rendered, the core file read) would hold the render up and let the fill go first.
	function quietNow() {
		if(syncer.isDirty() || syncer.forceSyncFromServer) {
			return false;
		}
		var lastList = adaptor.cfworkerListedSince ? adaptor.cfworkerListedSince() : 0;
		if(lastList && Date.now() - lastList < lib.wait(LIST_SETTLE)) {
			return false;
		}
		var loading = adaptor.cfworkerLoading ? adaptor.cfworkerLoading() : null;
		if(!loading) {
			return syncer.numTasksInProgress === 0 && $tw.utils.count(syncer.titlesToBeLoaded) === 0;
		}
		// A task under way that isn't a load: a save, a delete, the list
		if(syncer.numTasksInProgress > $tw.utils.count(loading)) {
			return false;
		}
		return !pageTitles().some(function(title) {
			return !!syncer.titlesToBeLoaded[title] || !!loading[title];
		});
	}

	// When nothing is being saved, and nothing the page needs is being loaded
	function whenQuiet(done,callback) {
		var waited = 0;
		(function poll() {
			if(quietNow()) {
				return callback(true);
			}
			if((waited += lib.wait(QUIET_POLL)) >= QUIET_TIMEOUT) {
				return callback(false);
			}
			setTimeout(guarded(done,poll),lib.wait(QUIET_POLL));
		})();
	}

	// A tiddler this tab saved keeps the revision it had before (TiddlyWiki only records the new one in
	// the syncer): loaded again, so the shell holds the revision the worker lists, the one every other
	// tab has, and a page load doesn't take it for a change
	function refreshRevisions(done,callback) {
		var listed = adaptor.cfworkerListed() || {},
			stale = 0;
		$tw.utils.each(pageTitles(),function(title) {
			var tiddler = wiki.getTiddler(title);
			if(tiddler && $tw.utils.hop(listed,title) && String(tiddler.fields.revision) !== listed[title] && !tiddler.hasField("_is_skinny")) {
				syncer.enqueueLoadTiddler(title);
				stale++;
			}
		});
		if(stale) {
			whenQuiet(done,callback);
		} else {
			callback(true);
		}
	}

	function send(url,body,headers,callback) {
		$tw.utils.httpRequest({
			url: adaptor.host + url,
			type: "PUT",
			headers: headers,
			data: body,
			callback: function(err,data,xhr) {
				callback(err ? (data || err) : null,xhr && xhr.status,xhr);
			}
		});
	}

	function coreFile() {
		return wiki.renderTiddler("text/plain",CORE_TEMPLATE).replace(SNAPSHOT_SETTING,"");
	}

	function publish(text,print,done) {
		function sendShell() {
			var atSend = listGeneration;
			send("page/shell",text,{
				"Content-Type": "text/html; charset=utf-8",
				"X-Page-Fingerprint": print,
				"X-Page-Index": source.index,
				"X-Page-Shell": storedShell
			},guarded(done,function(err,status,xhr) {
				// Every answer that kept or keeps a shell says which version is stored now
				var version = xhr && xhr.getResponseHeader ? xhr.getResponseHeader("X-Page-Shell") : null;
				if(version !== null && version !== undefined) {
					storedShell = version;
				}
				if(err && status === 409 && version !== null && version !== undefined) {
					// Another tab published since the page this one sends was built: sync, so that
					// tab's change is here, and send the page again (a few times at most: each needs
					// another tab's publish in between)
					published = "";
					if(++rebased <= 3) {
						report("waiting","Page not published yet: another tab published it moments ago. It's sent again with that tab's change.");
						again = true;
						return done();
					}
					rebased = 0;
					return failed(done,err);
				}
				if(err) {
					return rejected(done,print,err,status);
				}
				rebased = 0;
				// A list showing another tab's change arrived while this was on its way: that tab may
				// publish a page with it, so which page is published isn't known after all
				if(listGeneration === atSend) {
					published = print;
				} else {
					published = "";
					again = true;
				}
				report("published","Page published.");
				done();
			}));
		}
		if(storedCore === coreVersion) {
			return sendShell();
		}
		send("page/core?v=" + encodeURIComponent(coreVersion),coreFile(),{"Content-Type": "application/javascript; charset=utf-8", "X-Page-Index": source.index},guarded(done,function(err,status) {
			if(err) {
				return rejected(done,print,err,status,true);
			}
			storedCore = coreVersion;
			sendShell();
		}));
	}

	// The shell, noting the tiddlers rendering it needed that hadn't loaded yet (TiddlyWiki starts
	// loading them): with any, the text is incomplete
	function shellNoting(loading) {
		var listener = function(title) {
			loading.push(title);
		};
		wiki.addEventListener("lazyLoad",listener);
		try {
			return shell();
		} finally {
			wiki.removeEventListener("lazyLoad",listener);
		}
	}

	// The complete shell, once what it needs has loaded: callback(text), or callback(null) if it
	// still isn't there after a few rounds
	function completeShell(done,callback,round) {
		var loading = [],
			text = shellNoting(loading);
		if(!loading.length) {
			return callback(text);
		}
		if((round || 0) >= 5) {
			return callback(null,loading);
		}
		whenQuiet(done,guarded(done,function() {
			completeShell(done,callback,(round || 0) + 1);
		}));
	}

	function stillLoading(done,titles) {
		report("waiting","Page not published yet: still loading" + (titles && titles.length ? " " + titles.join(", ") : "") + ". It will be tried again at the next save or reload.");
		done();
	}

	// afterSave: this tab has just saved something; otherwise the check after loading (already synced)
	function run(afterSave,done) {
		if(wiki.getTiddlerText("$:/status/IsReadOnly") === "yes") {
			return done();
		}
		if(afterSave) {
			// Nothing to do if the page this tab renders is the one published (or refused)
			var loading = [],
				text = shellNoting(loading);
			if(!loading.length && settled(fingerprint(text))) {
				return done();
			}
			syncer.syncFromServer();
		}
		whenQuiet(done,guarded(done,function(quiet) {
			if(!quiet) {
				return stillLoading(done);
			}
			refreshRevisions(done,guarded(done,function() {
				completeShell(done,guarded(done,function(text,loading) {
					if(text === null) {
						return stillLoading(done,loading);
					}
					var print = fingerprint(text);
					if(settled(print)) {
						return done();
					}
					publish(text,print,done);
				}));
			}));
		}));
	}

	function check(afterSave) {
		if(busy) {
			again = true;
			return;
		}
		busy = true;
		var finished = false;
		// Called once, whatever happens (an error after the step that already finished, say)
		function done() {
			if(finished) {
				return;
			}
			finished = true;
			busy = false;
			if(again) {
				again = false;
				check(true);
			}
		}
		guarded(done,run)(afterSave,done);
	}

	function schedule() {
		if(started) {
			clearTimeout(timer);
			timer = setTimeout(function() {
				check(true);
			},parseInt(wiki.getTiddlerText("$:/config/cfworker/PublishPause",""),10) || lib.wait(PAUSE));
		}
	}

	// This tab's own saves and deletes
	var saveTiddler = adaptor.saveTiddler,
		deleteTiddler = adaptor.deleteTiddler;
	adaptor.saveTiddler = function(tiddler,callback,options) {
		var title = tiddler.fields.title;
		return saveTiddler.call(this,tiddler,function(err,adaptorInfo,revision) {
			if(!err) {
				ownChanges[title] = {stored: true, time: Date.now(), revision: revision};
				schedule();
			}
			return callback.apply(this,arguments);
		},options);
	};
	adaptor.deleteTiddler = function(title,callback,options) {
		return deleteTiddler.call(this,title,function(err) {
			if(!err) {
				ownChanges[title] = {stored: false, time: Date.now()};
				schedule();
			}
			return callback.apply(this,arguments);
		},options);
	};

	// Whether a tiddler can be in the page, or change it: a system tiddler (a plugin, the site title...)
	// or one with a raw markup tag (fields: its list entry)
	function mayChangePage(title,fields) {
		if(title.indexOf("$:/") === 0) {
			return true;
		}
		var tags = fields && fields.tags,
			tiddler = wiki.getTiddler(title);
		tags = typeof tags === "string" ? $tw.utils.parseStringArray(tags) : ($tw.utils.isArray(tags) ? tags : []);
		return RAW_MARKUP_TAGS.some(function(tag) {
			return tags.indexOf(tag) !== -1 || (!!tiddler && tiddler.hasTag(tag));
		});
	}

	// A tiddler list showing a change to such a tiddler that this tab didn't make (its own saves are
	// recognised by their revision, its deletes by the title's absence): another tab may have published
	// a page with it, so the page published is no longer the one this tab knows
	if(adaptor.cfworkerOnList) {
		adaptor.cfworkerOnList(function(listed,previous,entries) {
			if(!previous || !published) {
				return;
			}
			var fields = Object.create(null);
			$tw.utils.each(entries,function(entry) {
				fields[entry.title] = entry;
			});
			var changed = Object.keys(listed).concat(Object.keys(previous)).some(function(title) {
				if(listed[title] === previous[title] || !mayChangePage(title,fields[title])) {
					return false;
				}
				var own = ownChanges[title];
				return !own || (own.stored ? listed[title] !== own.revision : $tw.utils.hop(listed,title));
			});
			if(changed) {
				published = "";
				listGeneration++;
			}
		});
	}

	// Once the worker's tiddler list has arrived and everything has loaded
	(function start() {
		var listed = adaptor.cfworkerListed();
		if(!listed) {
			return setTimeout(start,lib.wait(START_POLL));
		}
		recordWhatCameWithPage(listed);
		whenQuiet(function() {},function() {
			started = true;
			check(false);
		});
	})();
};
