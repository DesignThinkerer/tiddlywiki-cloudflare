/*\
title: $:/cfworker/control-panel.js
type: application/javascript
module-type: startup

On the admin site, a "Cloudflare" tab in the control panel's Saving tab ($:/temp/cfworker/ControlPanel):
how backups go (from $:/temp/cfworker/backup-status, kept by $:/cfworker/backup-alert.js), the last
full backup, and the button that starts one (POST /backup/sync, design 1.7) or refreshes its status
(GET /backup/sync). The worker answers are handed to the backup alert module, which keeps the status
tiddler the tab shows.
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
	START = "tm-cfworker-backup-sync",
	REFRESH = "tm-cfworker-backup-status";

var TAB_TEXT = [
	"!! Backups to GitHub",
	"",
	"<$list filter='[[" + STATUS + "]get[backups]match[off]]' variable='off'>",
	"Backups are off: the worker has no `GITHUB_REPO` and `GITHUB_TOKEN` (README 2.4). Set them, and every save is committed to GitHub.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[backups]match[on]]' variable='on'>",
	"Every save is committed to GitHub as it happens (README 2.4).",
	"",
	"!!! Full backup",
	"",
	"A full backup makes GitHub mirror the wiki: tiddlers saved before backups were set up (an imported wiki, say), restored, or put in the bucket by hand are committed, and files of tiddlers no longer in the wiki are removed. Run it once after setting backups up, after a restore, or in any doubt; run again, it changes nothing. It goes on without this tab, at GitHub's pace (about 500 commits an hour), and this tab follows it.",
	"",
	"<$list filter='[[" + STATUS + "]has[sync-id]]' variable='some' emptyMessage='No full backup yet.'>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[yes]]' variable='running'>",
	"Running: {{" + STATUS + "!!sync-done}} of {{" + STATUS + "!!sync-total}} tiddlers walked, {{" + STATUS + "!!sync-committed}} committed, {{" + STATUS + "!!sync-removed}} removed, {{" + STATUS + "!!sync-failed}} refused by GitHub (as of <$view tiddler='" + STATUS + "' field='sync-updated' format='date' template='0hh:0mm:0ss'/>).",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[no]] :filter[[" + STATUS + "]has[sync-finished]]' variable='over'>",
	"Last full backup: <$view tiddler='" + STATUS + "' field='sync-finished' format='date' template='DDth MMM YYYY 0hh:0mm'/>, {{" + STATUS + "!!sync-done}} tiddlers walked, {{" + STATUS + "!!sync-committed}} committed, {{" + STATUS + "!!sync-removed}} removed, {{" + STATUS + "!!sync-failed}} refused by GitHub.",
	"</$list>",
	"<$list filter='[[" + STATUS + "]get[sync-running]match[no]] :filter[[" + STATUS + "]!has[sync-finished]]' variable='lost'>",
	"The last full backup stopped without finishing (its steps were lost): start it again.",
	"</$list>",
	"</$list>",
	"<$list filter='[[" + STATUS + "]has[sync-error]]' variable='problem'>",
	"",
	"Its last step didn't go through: ``{{" + STATUS + "!!sync-error}}``. It's tried again by itself.",
	"</$list>",
	"",
	"<$button message='" + START + "'>Back up everything to GitHub</$button> <$button message='" + REFRESH + "'>Refresh</$button>",
	"",
	"<$list filter='[[" + MESSAGE + "]has[text]]' variable='said'>",
	"{{" + MESSAGE + "}}",
	"</$list>",
	"</$list>"
].join("\n");

exports.startup = function() {
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || !Adaptor.prototype.cfworkerNoteBackupStatus || Adaptor.prototype.cfworkerControlPanel || typeof window === "undefined") {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		publicBase = lib.publicBase(),
		here = window.location.origin + "/";
	// Only the admin site, the page served by the worker (the public one is read-only and has no
	// worker behind it). The sync adaptor itself exists only after TiddlyWiki's own startup.
	if(!publicBase || lib.siteOf(here) === lib.siteOf(publicBase)) {
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
				say((status ? "The worker answered " + status + ": " : "The worker didn't answer: ") + String(data || err || "").slice(0,300));
			}
		});
	}

	$tw.rootWidget.addEventListener(START,function() {
		request("POST");
		return false;
	});
	$tw.rootWidget.addEventListener(REFRESH,function() {
		request("GET");
		return false;
	});
};

})();
