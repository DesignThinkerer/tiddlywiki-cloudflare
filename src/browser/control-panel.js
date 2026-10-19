/*\
title: $:/cfworker/control-panel.js
type: application/javascript
module-type: startup

On the admin site, a "Cloudflare" tab in the control panel's Saving tab ($:/temp/cfworker/ControlPanel):
the setup check (GET /setup/check, design 1.13: each piece of the setup looked at by the worker, this
browser's service worker and its copy of the core file added here, the lines kept in
$:/temp/cfworker/setup-check); the engine (design 1.15: the TiddlyWiki version the page was built
from and the one the worker ships, both in $:/cfworker/page-source, kept in $:/temp/cfworker/engine;
when they differ, the button that has the worker replace index.html with the shipped one, POST
/engine/update, after a second ask in the tab); how backups go (from $:/temp/cfworker/backup-status,
kept by $:/cfworker/backup-alert.js), the last full backup, and the button that starts one (POST
/backup/sync, design 1.7) or refreshes its status (GET /backup/sync). The worker answers about
backups are handed to the backup alert module, which keeps the status tiddler the tab shows.
\*/
(function(){

"use strict";

exports.name = "cfworker-control-panel";
exports.platforms = ["browser"];
exports.after = ["cfworker-backup-alert"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

var TAB = "$:/temp/cfworker/ControlPanel",
	STATUS = "$:/temp/cfworker/backup-status",
	MESSAGE = "$:/temp/cfworker/backup-sync-message",
	SETUP = "$:/temp/cfworker/setup-check",
	START = "tm-cfworker-backup-sync",
	REFRESH = "tm-cfworker-backup-status",
	CHECK = "tm-cfworker-setup-check",
	ENGINE = "$:/temp/cfworker/engine",
	ENGINE_MESSAGE = "$:/temp/cfworker/engine-message",
	PAGE_SOURCE = "$:/cfworker/page-source",
	UPDATE = "tm-cfworker-engine-update",
	RELOAD = "tm-cfworker-engine-reload",
	CACHE = lib.SW_CACHE;   // the service worker's cache

var TAB_TEXT = [
	"!! The setup",
	"",
	"What's set up by hand, looked at: Cloudflare Access; the public site, its rewrite rule, its CORS rule (both paths) and its cache rules; backups and the queue; purges; and this browser's copy for opening offline. A missing piece names the section of the setup guide that fixes it, with a link. It runs only when asked (the worker makes a few requests of its own, and purges the public site's status file to test the purge token).",
	"",
	"<$button message='" + CHECK + "'>Check the setup</$button>",
	"",
	"<$list filter='[[" + SETUP + "]has[text]]' variable='checked'>",
	"{{" + SETUP + "}}",
	"</$list>",
	"",
	"!! The engine",
	"",
	"<$list filter='[[" + ENGINE + "]get[same]match[yes]]' variable='same'>TiddlyWiki {{" + ENGINE + "!!engine}}, the version the worker ships.</$list>",
	"<$list filter='[[" + ENGINE + "]get[same]match[no]]' variable='differs'>TiddlyWiki <$list filter='[[" + ENGINE + "]has[engine]]' variable='known' emptyMessage='of an unknown version (the engine has no version tag)'>{{" + ENGINE + "!!engine}}</$list> — the worker ships {{" + ENGINE + "!!shipped}}. <$list filter='[[" + ENGINE + "]!field:replaced[yes]]' variable='pending'><$button set='" + ENGINE + "!!ask' setTo='yes'>Update the engine</$button></$list>",
	"",
	"<$reveal state='" + ENGINE + "!!ask' type='match' text='yes'>",
	"",
	"The worker replaces the engine (`index.html`) with the one it ships, TiddlyWiki {{" + ENGINE + "!!shipped}}; the next page load runs it, publishes it and purges the public copy. Your tiddlers, the plugins you installed and the published page stay. What goes: a plugin that came with the current engine and wasn't installed from the wiki (an engine you uploaded yourself, say). A plugin you updated from the library keeps your version (" + lib.guide("operating","3.4") + ").",
	"",
	"<$button message='" + UPDATE + "'>Replace it</$button> <$button set='" + ENGINE + "!!ask' setTo='no'>Not now</$button>",
	"",
	"</$reveal>",
	"</$list>",
	"<$list filter='[[" + ENGINE_MESSAGE + "]has[text]]' variable='said'>",
	"",
	"{{" + ENGINE_MESSAGE + "}}",
	"</$list>",
	"",
	"!! Backups to GitHub",
	"",
	"<$list filter='[[" + STATUS + "]!has[backups]]' variable='unknown'>",
	"Not known yet: the worker hasn't said whether backups are on. It's asked with the page's first tiddler list request; with no network, the answer waits for it.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[backups]match[off]]' variable='off'>",
	"Backups are off: the worker has no `GITHUB_REPO` and `GITHUB_TOKEN` (" + lib.guide("setup","2.4") + "). Set them, and every save is committed to GitHub.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[backups]match[on]]' variable='on'>",
	"",
	"Every save is committed to GitHub as it happens (" + lib.guide("setup","2.4") + ").",
	"",
	"!!! Full backup",
	"",
	"A full backup makes GitHub mirror the wiki: tiddlers saved before backups were set up (an imported wiki, say), restored, or put in the bucket by hand are committed, and files of tiddlers no longer in the wiki are removed. Run it once after setting backups up, after a restore, or in any doubt; run again, it changes nothing. It goes on without this tab, at GitHub's pace (about 500 commits an hour), and this tab follows it.",
	"",
	"<$list filter='[[" + STATUS + "]has[sync-id]]' variable='some' emptyMessage='No full backup yet.'>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[yes]]' variable='running'>",
	"Running: {{" + STATUS + "!!sync-done}} of {{" + STATUS + "!!sync-total}} tiddlers walked, {{" + STATUS + "!!sync-committed}} committed, {{" + STATUS + "!!sync-removed}} removed, {{" + STATUS + "!!sync-failed}} refused by GitHub (as of <$view tiddler='" + STATUS + "' field='sync-updated' format='date' template='0hh:0mm:0ss'/>).",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[no]] :filter[[" + STATUS + "]has[sync-finished]] :filter[[" + STATUS + "]!has[sync-error]]' variable='over'>",
	"Last full backup: <$view tiddler='" + STATUS + "' field='sync-finished' format='date' template='DDth MMM YYYY 0hh:0mm'/>, {{" + STATUS + "!!sync-done}} tiddlers walked, {{" + STATUS + "!!sync-committed}} committed, {{" + STATUS + "!!sync-removed}} removed, {{" + STATUS + "!!sync-failed}} refused by GitHub.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[no]] :filter[[" + STATUS + "]has[sync-finished]] :filter[[" + STATUS + "]has[sync-error]]' variable='refused'>",
	"The last full backup didn't go through: <code><$text text={{" + STATUS + "!!sync-error}}/></code> (<$view tiddler='" + STATUS + "' field='sync-finished' format='date' template='DDth MMM YYYY 0hh:0mm'/>). Start it again.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[no]] :filter[[" + STATUS + "]!has[sync-finished]]' variable='lost'>",
	"The last full backup stopped without finishing (its steps were lost<$list filter='[[" + STATUS + "]has[sync-error]]' variable='problem'>; its last step's error: <code><$text text={{" + STATUS + "!!sync-error}}/></code></$list>): start it again.",
	"</$list>",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[yes]] :filter[[" + STATUS + "]has[sync-error]]' variable='problem'>",
	"",
	"Its last step didn't go through: <code><$text text={{" + STATUS + "!!sync-error}}/></code>. It's tried again by itself.",
	"</$list>",
	"",
	"<$button message='" + START + "'>Back up everything to GitHub</$button> <$button message='" + REFRESH + "'>Refresh</$button>",
	"",
	"<$list filter='[[" + MESSAGE + "]has[text]]' variable='said'>",
	"{{" + MESSAGE + "}}",
	"</$list>",
	"",
	"</$list>"
].join("\n");

exports.startup = function() {
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || !Adaptor.prototype.cfworkerNoteBackupStatus || Adaptor.prototype.cfworkerControlPanel || typeof window === "undefined") {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		here = window.location.origin + "/";
	// Only the admin site, the page served by the worker (the public one is read-only and has no
	// worker behind it). The sync adaptor itself exists only after TiddlyWiki's own startup.
	if(!lib.onAdminSite(here)) {
		return;
	}
	proto.cfworkerControlPanel = true;

	wiki.addTiddler(new $tw.Tiddler({
		title: TAB,
		caption: "Cloudflare",
		tags: ["$:/tags/ControlPanel/Saving"],
		text: TAB_TEXT
	}));

	function say(text) {
		if(text) {
			wiki.addTiddler(new $tw.Tiddler({title: MESSAGE, text: text}));
		} else if(wiki.tiddlerExists(MESSAGE)) {
			wiki.deleteTiddler(MESSAGE);
		}
	}
	// A worker answer in a message: the worker's own words as they are (plain text, with a link to
	// the manual in them), and anything else (an error page from the edge: HTML) as text, not markup
	function shown(answer) {
		return String(answer || "").slice(0,300).replace(/</g,"&lt;");
	}

	// POST or GET /backup/sync: a JSON status (202 started, 409 one is running, 200 the last one),
	// or a text saying what's missing (400) or what failed
	function request(method) {
		say(method === "POST" ? "Starting…" : "");
		var host = ($tw.syncadaptor && $tw.syncadaptor.host) || here;
		$tw.utils.httpRequest({
			url: host + "backup/sync",
			type: method,
			headers: {"X-Requested-With": "TiddlyWiki"},
			callback: function(err,data,xhr) {
				var status = xhr ? xhr.status : 0, body = null;
				try {
					body = data ? JSON.parse(data) : null;
				} catch(e) {}
				if(body && typeof body === "object" && body.id) {
					proto.cfworkerNoteBackupStatus({backups: "on", problem: undefined, sync: body});
					say(status === 409 ? "A full backup is already running." : status === 202 ? "Started." : status === 503 ? "It couldn't be started: " + (body.error || "the queue didn't take it") + "." : "");
					return;
				}
				if(status === 200) {
					say("No full backup yet.");
					return;
				}
				say((status ? "The worker answered " + status + ": " : "The worker didn't answer: ") + shown(data || err));
			}
		});
	}

	$tw.rootWidget.addEventListener(START,function() {
		request("POST");
		return false;
	});

	// --- The engine ------------------------------------------------------------------------------------

	// The versions travel in the page: nothing to ask at load
	var source = null;
	try {
		source = JSON.parse(wiki.getTiddlerText(PAGE_SOURCE,"") || "null");
	} catch(e) {}
	var engine = (source && source.engine) || "", shipped = (source && source.shipped) || "";
	wiki.addTiddler(new $tw.Tiddler({title: ENGINE, engine: engine, shipped: shipped, same: engine && engine === shipped ? "yes" : "no", ask: "no"}));

	function engineSay(text) {
		wiki.addTiddler(new $tw.Tiddler({title: ENGINE_MESSAGE, text: text}));
	}
	$tw.rootWidget.addEventListener(UPDATE,function() {
		engineSay("Replacing…");
		wiki.setText(ENGINE,"ask",null,"no");
		var host = ($tw.syncadaptor && $tw.syncadaptor.host) || here;
		$tw.utils.httpRequest({
			url: host + "engine/update",
			type: "POST",
			headers: {"X-Requested-With": "TiddlyWiki"},
			callback: function(err,data,xhr) {
				var status = xhr ? xhr.status : 0, body = null;
				try {
					body = data ? JSON.parse(data) : null;
				} catch(e) {}
				if(status === 200 && body && body.to) {
					wiki.setText(ENGINE,"replaced",null,"yes");   // (the Update button goes: the reload runs the new engine)
					engineSay("Engine replaced: TiddlyWiki " + (body.from || "(unknown)") + " → " + body.to + ". <$button message='" + RELOAD + "'>Reload</$button> to run it: that load builds the page from it and publishes it.");
					return;
				}
				engineSay("The engine wasn't replaced. " + (status ? "The worker answered " + status + ": " : "The worker didn't answer: ") + shown(data || err));
			}
		});
		return false;
	});
	$tw.rootWidget.addEventListener(RELOAD,function() {
		window.location.reload();
		return false;
	});
	$tw.rootWidget.addEventListener(REFRESH,function() {
		request("GET");
		return false;
	});

	// --- The setup check ------------------------------------------------------------------------------

	// One line per piece: a mark (✓ fine, ✗ missing or wrong, – nothing to check or optional), the
	// worker's text, shown as text whatever it contains (addresses, quotes), and the section of the
	// manual that fixes it as a link ({ text, url }, the worker's or lib.guideLink's)
	function line(mark,text,guide) {
		return "<li><$text text=\"\"\"" + mark + " " + text + "\"\"\"/>" + (guide ? " ([[" + guide.text + "|" + guide.url + "]])" : "") + "</li>";
	}
	function mark(ok) {
		return ok === true ? "✓" : ok === false ? "✗" : "–";
	}
	// This browser's own two lines: the service worker in place, and its copy of the core file,
	// which is what the CORS rule's /_plugins/ path is for (design 1.11). Each links to the manual as
	// the worker's lines do: opening offline, or the rule when the copy is missing
	function browserLines(then) {
		var lines = [],
			offline = lib.guideLink("operating","3.13"),
			corsRule = lib.guideLink("setup","2.7"),
			controller = typeof navigator === "object" && navigator.serviceWorker && navigator.serviceWorker.controller;
		lines.push(line(mark(!!controller),controller ?
			"Opening offline: a service worker is in place in this browser." :
			"Opening offline: no service worker is in place in this browser yet. Reload the page once, online.",offline));
		if(typeof caches !== "object") {
			lines.push(line("–","This browser has no cache storage here: nothing kept for opening offline.",offline));
			return then(lines);
		}
		caches.open(CACHE).then(function(cache) {
			return cache.keys();
		}).then(function(keys) {
			var kept = keys.some(function(request) {
				return /\/_plugins\/tiddlywikicore\.js/.test(request.url);
			});
			lines.push(line(mark(kept),kept ?
				"...and the core file is kept on this device: the wiki opens with no network (the page and its plugin files with it)." :
				"...but the core file isn't kept on this device, so the wiki doesn't open with no network. On a public wiki, the CORS rule must cover /_plugins/ (see the line above); right after a first visit, give it a moment and check again.",kept ? offline : corsRule));
			then(lines);
		},function() {
			lines.push(line("–","The cache storage couldn't be read.",offline));
			then(lines);
		});
	}
	function show(lines,checked) {
		wiki.addTiddler(new $tw.Tiddler({
			title: SETUP,
			text: "<ul class='cfworker-setup-check'>\n" + lines.join("\n") + "\n</ul>\n\nChecked at <$view tiddler='" + SETUP + "' field='checked' format='date' template='0hh:0mm:0ss'/>.",
			checked: $tw.utils.stringifyDate(checked || new Date())
		}));
	}
	$tw.rootWidget.addEventListener(CHECK,function() {
		wiki.addTiddler(new $tw.Tiddler({title: SETUP, text: "Checking…"}));
		var host = ($tw.syncadaptor && $tw.syncadaptor.host) || here;
		$tw.utils.httpRequest({
			url: host + "setup/check",
			type: "GET",
			headers: {"X-Requested-With": "TiddlyWiki"},
			callback: function(err,data,xhr) {
				var status = xhr ? xhr.status : 0,
					body = null,
					lines = [];
				try {
					body = data ? JSON.parse(data) : null;
				} catch(e) {}
				var done = function() {
					browserLines(function(own) {
						show(lines.concat(own));
					});
				};
				if(body && Array.isArray(body.checks)) {
					$tw.utils.each(body.checks,function(item) {
						lines.push(line(mark(item.ok),String(item.text || ""),item.guide));
					});
					return done();
				}
				if(status) {
					lines.push(line("✗","The worker answered " + status + ": " + String(data || err || "").slice(0,300),""));
					return done();
				}
				// No answer at all: no network, or the Access session has expired (its login page, on
				// another origin, is blocked by the browser). The outbox tells the two apart by asking
				// Access (design 2.26), and learns it at the same time, for the cloud icon's dropdown
				var adaptor = $tw.syncadaptor,
					asked = adaptor && typeof adaptor.cfworkerNoAnswer === "function" ? adaptor.cfworkerNoAnswer() : Promise.resolve(null);
				asked.then(function(login) {
					lines.push(login === "expired" ?
						line("✗","The worker didn't answer: your login has expired, and Cloudflare Access sent the request to its login page instead. Log in again (the cloud icon's dropdown has the link), then check again.",lib.guideLink("operating","3.14")) :
						line("✗","The worker didn't answer (no network, or it can't be reached): " + String(err || "").slice(0,300),""));
					done();
				});
			}
		});
		return false;
	});
};

})();
