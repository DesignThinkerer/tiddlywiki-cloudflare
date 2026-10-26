/*\
title: $:/cfworker/control-panel.js
type: application/javascript
module-type: startup

On the admin site, a "Cloudflare" tab in the control panel's Saving tab ($:/temp/cfworker/ControlPanel):
the setup check (GET /setup/check, design 1.13: each piece of the setup looked at by the worker, this
browser's service worker and its copy of the core file added here, the lines kept in
$:/temp/cfworker/setup-check); the worker's release (design 1.17: the version and build written in
$:/temp/cfworker/release here, the rest by $:/cfworker/release-check.js, the widget the tab renders,
which asks GitHub for the newest release when the tab is shown); the engine (design 1.15: the TiddlyWiki version the page was built
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
	PAGE_STATUS = "$:/temp/cfworker/page-publisher",   // what this tab last did with the page: state, text, time (page-publisher.js)
	ENGINE_MESSAGE = "$:/temp/cfworker/engine-message",
	PAGE_SOURCE = "$:/cfworker/page-source",
	RELEASE = "$:/temp/cfworker/release",
	ADMIN_PLUGIN = "$:/plugins/cfworker/admin",
	UPDATE = "tm-cfworker-engine-update",
	RELOAD = "tm-cfworker-engine-reload",
	CACHE = lib.SW_CACHE;   // the service worker's cache

var TAB_TEXT = [
	"This wiki saves each change to the worker as you make it. The saver tabs beside this one are TiddlyWiki's, for single-file wikis, and aren't used here; backups to GitHub are set in the worker's dashboard (" + lib.guide("setup","2.4") + ").",
	"",
	"!! The setup",
	"",
	"Looks at each piece set up by hand (Access, the public site and its rules, backups and the queue, purges, this browser's offline copy) and, for a missing one, says what to do (" + lib.guide("operating","3.15") + ").",
	"",
	"<$button message='" + CHECK + "'>Check the setup</$button>",
	"",
	"Runs only when you click: the worker makes a few requests and purges the public site's status file to test the purge token.",
	"",
	// (each button's answer sits in a live region that is there before the answer, so a screen
	// reader hears it once it's in: design 2.17)
	"<div role='status' aria-live='polite'>",
	"",
	"<$list filter='[[" + SETUP + "]has[text]]' variable='checked'>",
	"{{" + SETUP + "}}",
	"</$list>",
	"",
	"</div>",
	"",
	"!! Backups to GitHub",
	"",
	"<$list filter='[[" + STATUS + "]!has[backups]]' variable='unknown'>",
	"Not known yet: the worker hasn't said whether backups are on. It's asked with the page's first tiddler list request; with no network, the answer waits for it.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[backups]match[off]]' variable='off'>",
	"Backups are off (optional): set `GITHUB_REPO` and the `GITHUB_TOKEN` secret (" + lib.guide("setup","2.4") + ") to commit every save to GitHub: the wiki's only history, since the bucket keeps the current version of each tiddler alone, and a deletion or an overwrite is final.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[backups]match[on]]' variable='on'>",
	"",
	"<$list filter='[[" + STATUS + "]has[problem-since]]' variable='failing'>",
	"",
	"{{" + STATUS + "!!problem-text}}",
	"",
	"</$list>",
	"<$list filter='[[" + STATUS + "]!has[problem-since]]' variable='fine'>",
	"",
	"<$list filter='[[" + STATUS + "]has[commits]]' variable='linked'>Every save is committed to GitHub as it happens: <a href={{{ [[" + STATUS + "]get[commits]] }}} target='_blank' rel='noopener noreferrer'>the commits</a> (" + lib.guide("setup","2.4") + ").</$list><$list filter='[[" + STATUS + "]!has[commits]]' variable='plain'>Every save is committed to GitHub as it happens (" + lib.guide("setup","2.4") + ").</$list>",
	"",
	"</$list>",
	"!!! Full backup",
	"",
	"",
	"<$list filter='[[" + STATUS + "]has[sync-id]]' variable='some' emptyMessage='No full backup yet.'>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[yes]]' variable='running'>",
	"Running: {{" + STATUS + "!!sync-done}} of {{" + STATUS + "!!sync-total}} tiddlers walked, {{" + STATUS + "!!sync-committed}} committed, {{" + STATUS + "!!sync-removed}} removed, {{" + STATUS + "!!sync-failed}} not backed up (refused by GitHub, or too big to back up), as of <$view tiddler='" + STATUS + "' field='sync-updated' format='date' template='0hh:0mm:0ss'/>.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[no]] :filter[[" + STATUS + "]has[sync-finished]] :filter[[" + STATUS + "]!has[sync-error]]' variable='over'>",
	"Last full backup: <$view tiddler='" + STATUS + "' field='sync-finished' format='date' template='DDth MMM YYYY 0hh:0mm'/>, {{" + STATUS + "!!sync-done}} tiddlers walked, {{" + STATUS + "!!sync-committed}} committed, {{" + STATUS + "!!sync-removed}} removed, {{" + STATUS + "!!sync-failed}} not backed up (refused by GitHub, or too big to back up).",
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
	"<$button message='" + START + "'>Back up everything to GitHub</$button> <$button message='" + REFRESH + "'>Refresh the status</$button>",
	"",
	"<div role='status' aria-live='polite'>",
	"",
	"<$list filter='[[" + MESSAGE + "]has[text]]' variable='said'>",
	"{{" + MESSAGE + "}}",
	"</$list>",
	"",
	"</div>",
	"",
	"Makes GitHub match the wiki: commits what isn't there yet, removes what's gone. Run it once after setting backups up or after a restore; run again, it changes nothing. It goes on without this tab, at about 500 commits an hour (" + lib.guide("setup","2.4") + ").",
	"",
	"</$list>",
	"",
	"!! The worker",
	"",
	"<$cfworker-release/><$list filter='[[" + RELEASE + "]!has[worker]]' variable='current'>Version {{" + RELEASE + "!!version}} (build {{" + RELEASE + "!!build}}). </$list><$list filter='[[" + RELEASE + "]has[worker]]' variable='behind'>This tab runs {{" + RELEASE + "!!version}} (build {{" + RELEASE + "!!build}}); the worker runs {{" + RELEASE + "!!worker}} (build {{" + RELEASE + "!!worker-build}}): reload this tab (what you're typing is kept on the device). </$list><$transclude tiddler='" + RELEASE + "' mode='inline'/>",
	"",
	"!! The engine",
	"",
	"<$list filter='[[" + ENGINE + "]get[same]match[yes]]' variable='same'>TiddlyWiki {{" + ENGINE + "!!engine}}, the version the worker ships.</$list>",
	"<$list filter='[[" + ENGINE + "]get[same]match[no]]' variable='differs'>",
	"<$list filter='[[" + ENGINE + "]get[newer]match[no]]' variable='older'>TiddlyWiki <$list filter='[[" + ENGINE + "]has[engine]]' variable='known' emptyMessage='of an unknown version (the engine has no version tag)'>{{" + ENGINE + "!!engine}}</$list> — the worker ships {{" + ENGINE + "!!shipped}}. <$list filter='[[" + ENGINE + "]!field:replaced[yes]]' variable='pending'><$button set='" + ENGINE + "!!ask' setTo='yes'>Update the engine</$button></$list></$list>",
	"<$list filter='[[" + ENGINE + "]get[newer]match[yes]]' variable='newer'>TiddlyWiki {{" + ENGINE + "!!engine}}, newer than the {{" + ENGINE + "!!shipped}} the worker ships. Usually you update your copy of the worker (" + lib.guide("operating","3.1") + ") once it ships {{" + ENGINE + "!!engine}}; if the page isn't published, see troubleshooting (" + lib.guide("troubleshooting","4") + "). <$list filter='[[" + ENGINE + "]!field:replaced[yes]]' variable='pending'><$button set='" + ENGINE + "!!ask' setTo='yes'>Go back to {{" + ENGINE + "!!shipped}}</$button></$list></$list>",
	"",
	"<$reveal state='" + ENGINE + "!!ask' type='match' text='yes'>",
	"",
	"The worker replaces the engine (`index.html`) with the one it ships, TiddlyWiki {{" + ENGINE + "!!shipped}}; the next page load runs it, publishes it and purges the public copy. This can't be undone from the tab: the current `index.html` isn't kept anywhere. If you uploaded it yourself, download it from R2 first (R2 → the bucket → Objects → index.html). <$list filter='[[" + ENGINE + "]get[newer]match[yes]]' variable='back'>Tiddlers saved by {{" + ENGINE + "!!engine}} will run on {{" + ENGINE + "!!shipped}}. </$list>Your tiddlers, the plugins you installed and the published page stay. What goes: a plugin that came with the current engine and wasn't installed from the wiki (an engine you uploaded yourself, say). A plugin you updated from the library keeps your version: to take the new engine's, delete your copy after Replace it and before you reload (wait for the save). Deleted later, it's gone, and operating 3.4's steps in R2 (delete `_page/shell.html` and `baked.html`, open the admin wiki) bring the new engine's version back. A new TiddlyWiki can break a plugin: if the wiki doesn't start after the reload, " + lib.guide("operating","3.6") + " (" + lib.guide("operating","3.3") + ").",
	"",
	"<$button message='" + UPDATE + "'>Replace it</$button> <$button set='" + ENGINE + "!!ask' setTo='no'>Not now</$button>",
	"",
	"</$reveal>",
	"</$list>",
	"<div role='status' aria-live='polite'>",
	"",
	"<$list filter='[[" + ENGINE_MESSAGE + "]has[text]]' variable='said'>",
	"",
	"{{" + ENGINE_MESSAGE + "}}",
	"</$list>",
	"",
	"</div>",
	"",
	"!! The page",
	"",
	"<$list filter='[[" + PAGE_STATUS + "]has[state]]' variable='known' emptyMessage='Nothing published from this tab since it loaded.'>From this tab, <$view tiddler='" + PAGE_STATUS + "' field='time' format='date' template='DDth MMM 0hh:0mm'/>: <$text text={{" + PAGE_STATUS + "!!text}}/> (" + lib.guide("operating","3.5") + ")</$list>",
	"",
	"The plugin's settings: <$link to='$:/plugins/cfworker/admin' tabIndex='settings'>its settings tab</$link>; what this browser keeps, and forgetting it: <$link to='$:/plugins/cfworker/admin'>its device tab</$link> (Control Panel → Plugins → TiddlyWiki on Cloudflare).",
	"",
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

	// First of Saving's sub-tabs (list-before empty: an empty field survives new $tw.Tiddler), ahead of
	// TiddlyWiki's saver tabs, which this wiki never uses; a link to the tiddler itself opens the tab's
	// content in the story, which the backup hint and the manual use (design 1.13)
	wiki.addTiddler(new $tw.Tiddler({
		title: TAB,
		caption: "Cloudflare",
		tags: ["$:/tags/ControlPanel/Saving"],
		"list-before": "",
		text: TAB_TEXT
	}));

	// The worker's version for the tab's "The worker" line: the plugin's, package.json's date before the
	// "+", the build hash after; the release check module fills in the rest when the tab is shown
	var full = String((wiki.getTiddler(ADMIN_PLUGIN) || {fields: {}}).fields.version || ""), plus = full.indexOf("+");
	wiki.addTiddler(new $tw.Tiddler({title: RELEASE, version: plus >= 0 ? full.slice(0,plus) : full, build: plus >= 0 ? full.slice(plus + 1) : ""}));

	// A tab left open across a deploy keeps the old modules: every list answer names the worker's plugin
	// version (X-Wiki-Plugin; a cached answer carries the version it was cached with, so it's left out),
	// and one that isn't this page's raises TiddlyWiki's own reload bar
	// ($:/status/RequireReloadDueToPluginChange, which the core's sync filter leaves out) and puts the
	// worker's version on the release tiddler, for the tab's line and the release check (design 2.21).
	// The hook sends a header so that its answer is read (list-sync.js reads the answers of the hooks
	// that asked); the worker ignores it
	var RELOAD_STATUS = "$:/status/RequireReloadDueToPluginChange";
	proto.cfworkerOnListRequest({
		headers: function() {
			return {"X-Wiki-Plugin": "?"};
		},
		answer: function(xhr) {
			if(!xhr || !xhr.getResponseHeader || xhr.getResponseHeader("X-Served-From") === "cache") {
				return;
			}
			var worker = xhr.getResponseHeader("X-Wiki-Plugin");
			if(!worker || worker === full) {
				return;
			}
			var at = worker.indexOf("+"), release = wiki.getTiddler(RELEASE);
			if(release && release.fields.worker === (at >= 0 ? worker.slice(0,at) : worker)) {
				return;
			}
			wiki.addTiddler(new $tw.Tiddler(release || {title: RELEASE},{worker: at >= 0 ? worker.slice(0,at) : worker, "worker-build": at >= 0 ? worker.slice(at + 1) : ""}));
			if(wiki.getTiddlerText(RELOAD_STATUS,"") !== "yes") {
				wiki.addTiddler(new $tw.Tiddler({title: RELOAD_STATUS, text: "yes"}));
			}
		}
	});

	function say(text) {
		if(text) {
			wiki.addTiddler(new $tw.Tiddler({title: MESSAGE, text: text}));
		} else if(wiki.tiddlerExists(MESSAGE)) {
			wiki.deleteTiddler(MESSAGE);
		}
	}
	// A request of this tab's own that got no answer at all (status 0): the network gone, the worker
	// unreachable, or the Access session expired (its login page, on another origin, is blocked by the
	// browser). The outbox tells the login from the rest by asking Access (design 2.26), and the
	// browser knows when it's offline. then(text, guide): the words, in the manual's, and the section
	// to link; never the XHR's "error code: 0". forCheck: the setup check's own wording
	function noAnswer(forCheck,then) {
		var adaptor = $tw.syncadaptor,
			asked = adaptor && typeof adaptor.cfworkerNoAnswer === "function" ? adaptor.cfworkerNoAnswer() : Promise.resolve(null);
		asked.then(function(login) {
			if(login === "expired") {
				return then("your login has expired, and Cloudflare Access sent the request to its login page instead. Log in again (the cloud icon's dropdown has the link), then " + (forCheck ? "check" : "try") + " again.",lib.guideLink("operating","3.14"));
			}
			if(typeof navigator === "object" && navigator.onLine === false) {
				return then("you're offline: the worker couldn't be asked." + (forCheck ? " Only this browser's two lines below were checked; check again once the network is back." : " Try again once the network is back."),lib.guideLink("operating","3.13"));
			}
			then("no network, or the worker can't be reached. Try again in a moment; the cloud icon's dropdown says which it was, once it knows.",lib.guideLink("operating",forCheck ? "3.15" : "3.13"));
		});
	}
	function noAnswerLink(guide) {
		return " ([[" + guide.text + "|" + guide.url + "]])";
	}
	// A worker answer in a message: the worker's own words as they are (plain text, with a link to
	// the manual in them), and anything else (an error page from the edge: HTML) as text, not markup
	// An answer that's a page rather than words: Cloudflare's error page, for an exception the worker
	// couldn't catch or its CPU limit, said so, with where the reason is (the dashboard's logs)
	var ERROR_PAGE = "Cloudflare's error page, not the worker's words (the worker threw, or ran out of CPU): the reason is in the worker's logs.";
	function isErrorPage(answer) {
		return /^\s*<(!doctype|html)/i.test(String(answer || ""));
	}
	function shown(answer) {
		if(isErrorPage(answer)) {
			return ERROR_PAGE + " (" + lib.guide("operating","3.8") + ")";
		}
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
				if(status) {
					say("The worker answered " + status + ": " + shown(data || err));
					return;
				}
				noAnswer(false,function(text,guide) {
					say("The worker didn't answer: " + text + noAnswerLink(guide));
				});
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
	// (newer: the engine ahead of the one the worker ships, uploaded by hand or the worker's copy
	// behind: the button then says "go back", since the update would be a downgrade)
	var engine = (source && source.engine) || "", shipped = (source && source.shipped) || "",
		newer = engine && shipped && lib.compareVersions(engine,shipped) > 0 ? "yes" : "no";
	wiki.addTiddler(new $tw.Tiddler({title: ENGINE, engine: engine, shipped: shipped, same: engine && engine === shipped ? "yes" : "no", newer: newer, ask: "no"}));

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
				if(status) {
					engineSay("The engine wasn't replaced. The worker answered " + status + ": " + shown(data || err));
					return;
				}
				noAnswer(false,function(text,guide) {
					engineSay("The engine wasn't replaced. The worker didn't answer: " + text + noAnswerLink(guide));
				});
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
	// manual that fixes it as a link ({ text, url }, the worker's or lib.guideLink's). The mark is a
	// span with its class, which the plugin's stylesheet colours (never the only signal: the glyph
	// stays), and a label a screen reader says as a word; the glyph first, a space after it, as the
	// lines are read (the suites, troubleshooting)
	// todo: the one thing to do, on its own line under what was found (the worker's own field, or the
	// browser's lines' below), before the link, so the reader finds the verb (design 2.20)
	// link: a second link after the section's, {text, url}: the page the line's action is on, the
	// dashboard's or GitHub's (the worker's own field, design 2.20)
	function line(mark,text,guide,todo,link) {
		var kind = mark === "✓" ? "ok" : mark === "✗" ? "bad" : "none",
			label = kind === "ok" ? "fine" : kind === "bad" ? "missing or wrong" : "not checked";
		return "<li><span class='cfworker-mark cfworker-mark-" + kind + "' aria-label='" + label + "'>" + mark + "</span> <$text text=\"\"\"" + text + "\"\"\"/>" +
			(todo ? " <br/>''To do:'' <$text text=\"\"\"" + todo + "\"\"\"/>" : "") +
			(guide ? " ([[" + guide.text + "|" + guide.url + "]])" : "") +
			(link ? " ([[" + link.text + "|" + link.url + "]])" : "") + "</li>";
	}
	function mark(ok) {
		return ok === true ? "✓" : ok === false ? "✗" : "–";
	}
	// This browser's own two lines: the service worker in place, and its copy of the core file,
	// which is what the CORS rule's /_plugins/ path is for (design 1.11). Each links to the manual as
	// the worker's lines do: opening offline, or the rule when the copy is missing; each with its own
	// subject, "Opening offline:", since each is its own item with its own mark (no "...and", which a
	// reader scanning for ✗ lands on without a subject, and a screen reader reads as "dot dot dot and")
	// corsFiles: the worker's own "cors-files" result (true, false, or null for a private wiki), which
	// says whether a missing copy of the core file is the CORS rule's doing (a public wiki whose rule
	// doesn't cover /_plugins/) or only the first visit's (the service worker takes its copy after the
	// page has loaded: one reload)
	function browserLines(corsFiles,then) {
		var lines = [],
			offline = lib.guideLink("operating","3.13"),
			corsRule = lib.guideLink("setup","2.7"),
			controller = typeof navigator === "object" && navigator.serviceWorker && navigator.serviceWorker.controller;
		lines.push(line(mark(!!controller),controller ?
			"Opening offline: a service worker is in place in this browser." :
			"Opening offline: no service worker is in place in this browser yet.",offline,controller ? null : "Reload the page once, online."));
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
				"Opening offline: the core file is kept on this device, so the wiki opens with no network (the page and its plugin files with it)." :
				corsFiles === false ?
					"Opening offline: the core file isn't kept on this device, so the wiki doesn't open with no network: the CORS rule doesn't cover /_plugins/ (\"The CORS rule, files\", above)." :
					"Opening offline: the core file isn't kept on this device yet, so the wiki doesn't open with no network: the service worker takes its copy after a first visit.",kept || corsFiles !== false ? offline : corsRule,
				kept ? null : corsFiles === false ? "Fix the rule, reload once online, then check again." : "Reload the page once, online, then check again."));
			then(lines);
		},function() {
			lines.push(line("–","The cache storage couldn't be read.",offline));
			then(lines);
		});
	}
	function show(lines,checked) {
		wiki.addTiddler(new $tw.Tiddler({
			title: SETUP,
			text: "<ul class='cfworker-setup-check'>\n" + lines.join("\n") + "\n</ul>\n\nChecked at <$view tiddler='" + SETUP + "' field='checked' format='date' template='DDth MMM 0hh:0mm'/>.",
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
				var corsFiles = null;
				var done = function() {
					browserLines(corsFiles,function(own) {
						show(lines.concat(own));
					});
				};
				if(body && Array.isArray(body.checks)) {
					$tw.utils.each(body.checks,function(item) {
						if(item.id === "cors-files") {
							corsFiles = item.ok;
						}
						lines.push(line(mark(item.ok),String(item.text || ""),item.guide,item.todo ? String(item.todo) : null,
							item.link && item.link.url && item.link.text ? item.link : null));
					});
					return done();
				}
				if(status) {
					lines.push(isErrorPage(data) ?
						line("✗","The worker answered " + status + ": " + ERROR_PAGE,lib.guideLink("operating","3.8")) :
						line("✗","The worker answered " + status + ": " + String(data || err || "").slice(0,300),""));
					return done();
				}
				// No answer at all: said in words (noAnswer), with the section as a link
				noAnswer(true,function(text,guide) {
					lines.push(line("✗","The worker didn't answer: " + text,guide));
					done();
				});
			}
		});
		return false;
	});
};

})();
