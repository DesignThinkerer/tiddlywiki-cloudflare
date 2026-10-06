/*\
title: $:/cfworker/page-publisher.js
type: application/javascript
module-type: startup

Publishes the page from the admin wiki (served by the Cloudflare worker), the way TiddlyWiki writes
its own file, but with the core in a separate file:

- The shell: TiddlyWiki's own $:/core/templates/tiddlywiki5-external-js.html, with the tiddlers that
  came with the page (the themes, TiddlyWeb: plugins the worker doesn't list) and your raw markup
  tiddlers. TiddlyWiki writes everything else: the title, the language, the raw markup, the content
  for browsers without JavaScript. The core is loaded at the end, from the public site.
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
Changes that arrive from other tabs aren't published by this one: their tab does it. Nothing is sent
while a tiddler the page needs is still loading, or in safe mode (#:safe). A failure is shown in a
notification and tried again at the next save or load.
\*/
"use strict";

exports.name = "cfworker-page-publisher";
exports.platforms = ["browser"];
exports.after = ["rootwidget"];
exports.synchronous = true;

var TEMPLATE = "$:/core/templates/tiddlywiki5-external-js.html",
	CORE_TEMPLATE = "$:/core/templates/tiddlywiki5.js",
	CORE_FORMAT = "1",   // changes when the core file is rendered differently: a new URL for it
	SOURCE = "$:/cfworker/page-source",
	PUBLIC_URL = "$:/cfworker/public-url",
	STATUS = "$:/temp/cfworker/page-publisher",
	RAW_MARKUP_TAGS = [
		"$:/core/wiki/rawmarkup", "$:/tags/RawMarkup", "$:/tags/RawMarkupWikified",
		"$:/tags/RawMarkupWikified/TopHead", "$:/tags/RawMarkupWikified/TopBody", "$:/tags/RawMarkupWikified/BottomBody"
	],
	PAUSE = 1000,          // after a save, so a burst of saves is published once
	QUIET_TIMEOUT = 60000; // waiting for saves and loads to finish

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
		publicBase = (wiki.getTiddlerText(PUBLIC_URL,"") || "").trim(),
		source = null;
	try {
		source = JSON.parse(wiki.getTiddlerText(SOURCE,"") || "null");
	} catch(e) {}
	if(publicBase && publicBase.charAt(publicBase.length - 1) !== "/") {
		publicBase += "/";
	}
	// Only on the admin site, with the worker's browser module
	if($tw.safeMode || !adaptor || !syncer || !source || !publicBase || adaptor.host === publicBase || typeof adaptor.cfworkerListed !== "function") {
		return;
	}
	var coreVersion = $tw.version + "-" + CORE_FORMAT,
		coreUrl = publicBase + "_plugins/tiddlywikicore.js?v=" + encodeURIComponent(coreVersion),
		published = source.fingerprint || "",   // what the page this tab loaded was built from
		storedCore = source.core || "",
		ownChanges = Object.create(null),      // title -> true (saved by this tab) or false (deleted)
		started = false,
		timer = null,
		busy = false,
		again = false;

	function onServer(title,listed) {
		return title in ownChanges ? ownChanges[title] : $tw.utils.hop(listed,title);
	}

	// The shell's tiddlers: the plugins that came with the page (the worker lists everything stored,
	// installed plugins included) and the raw markup tiddlers, without drafts. Like TiddlyWiki's own
	// save filters, without $:/temp/ (its $:/temp/info-plugin, made at each startup) and pending imports.
	function pageTitles() {
		var listed = adaptor.cfworkerListed() || {},
			titles = wiki.filterTiddlers("[all[tiddlers]has[plugin-type]!is[draft]] -[[$:/core]] -[prefix[$:/temp/]] -[prefix[$:/state/]] -[plugin-type[import]] -[has[plugin-type]field:platform[server]]").filter(function(title) {
				return !onServer(title,listed);
			});
		$tw.utils.each(RAW_MARKUP_TAGS,function(tag) {
			$tw.utils.pushTop(titles,wiki.filterTiddlers("[all[tiddlers]tag[" + tag + "]!is[draft]]"));
		});
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

	// When nothing is being saved or loaded
	function whenQuiet(callback) {
		var waited = 0;
		(function poll() {
			var quiet = !syncer.isDirty() && syncer.numTasksInProgress === 0 && $tw.utils.count(syncer.titlesToBeLoaded) === 0 && !syncer.forceSyncFromServer;
			if(quiet) {
				return callback(true);
			}
			if((waited += 200) >= QUIET_TIMEOUT) {
				return callback(false);
			}
			setTimeout(poll,200);
		})();
	}

	// A tiddler this tab saved keeps the revision it had before (TiddlyWiki only records the new one in
	// the syncer): loaded again, so the shell holds the revision the worker lists, the one every other
	// tab has, and a page load doesn't take it for a change
	function refreshRevisions(callback) {
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
			whenQuiet(callback);
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
			callback: function(err,data) {
				callback(err ? (data || err) : null);
			}
		});
	}

	function coreFile() {
		return wiki.renderTiddler("text/plain",CORE_TEMPLATE).replace(SNAPSHOT_SETTING,"");
	}

	function publish(text,print,done) {
		function failed(message) {
			report("failed","Page not published: " + message + " It will be tried again at the next save or reload.");
			done();
		}
		function sendShell() {
			send("page/shell",text,{
				"Content-Type": "text/html; charset=utf-8",
				"X-Page-Fingerprint": print,
				"X-Page-Index": source.index
			},function(err) {
				if(err) {
					return failed(err);
				}
				published = print;
				report("published","Page published.");
				done();
			});
		}
		if(storedCore === coreVersion) {
			return sendShell();
		}
		send("page/core?v=" + encodeURIComponent(coreVersion),coreFile(),{"Content-Type": "application/javascript; charset=utf-8"},function(err) {
			if(err) {
				return failed(err);
			}
			storedCore = coreVersion;
			sendShell();
		});
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
	function completeShell(callback,round) {
		var loading = [],
			text = shellNoting(loading);
		if(!loading.length) {
			return callback(text);
		}
		if((round || 0) >= 5) {
			return callback(null,loading);
		}
		whenQuiet(function() {
			completeShell(callback,(round || 0) + 1);
		});
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
			// Nothing to do if the page this tab renders is the one published
			var loading = [],
				text = shellNoting(loading);
			if(!loading.length && fingerprint(text) === published && storedCore === coreVersion) {
				return done();
			}
			syncer.syncFromServer();
		}
		whenQuiet(function(quiet) {
			if(!quiet) {
				return stillLoading(done);
			}
			refreshRevisions(function() {
				completeShell(function(text,loading) {
					if(text === null) {
						return stillLoading(done,loading);
					}
					var print = fingerprint(text);
					if(print === published && storedCore === coreVersion) {
						return done();
					}
					publish(text,print,done);
				});
			});
		});
	}

	function check(afterSave) {
		if(busy) {
			again = true;
			return;
		}
		busy = true;
		run(afterSave,function() {
			busy = false;
			if(again) {
				again = false;
				check(true);
			}
		});
	}

	function schedule() {
		if(started) {
			clearTimeout(timer);
			timer = setTimeout(function() {
				check(true);
			},PAUSE);
		}
	}

	// This tab's own saves and deletes
	var saveTiddler = adaptor.saveTiddler,
		deleteTiddler = adaptor.deleteTiddler;
	adaptor.saveTiddler = function(tiddler,callback,options) {
		var title = tiddler.fields.title;
		return saveTiddler.call(this,tiddler,function(err) {
			if(!err) {
				ownChanges[title] = true;
				schedule();
			}
			return callback.apply(this,arguments);
		},options);
	};
	adaptor.deleteTiddler = function(title,callback,options) {
		return deleteTiddler.call(this,title,function(err) {
			if(!err) {
				ownChanges[title] = false;
				schedule();
			}
			return callback.apply(this,arguments);
		},options);
	};

	// Once the worker's tiddler list has arrived and everything has loaded
	(function start() {
		if(!adaptor.cfworkerListed()) {
			return setTimeout(start,300);
		}
		whenQuiet(function() {
			started = true;
			check(false);
		});
	})();
};
