/*\
title: $:/cfworker/backup-alert.js
type: application/javascript
module-type: startup

On the admin site, asks how backups to GitHub go, with the tiddler list request (the worker reads
the backup status only then, and answers in a header of the same response: no extra request), when
the page loads, then hourly, and at each request while the alert shows or a full backup runs; keeps
the answer in $:/temp/cfworker/backup-status (whether backups are on, the last full backup: the
control panel's Cloudflare tab reads it, $:/cfworker/control-panel.js); shows an alert while backups
keep failing, and one for a backup the runtime cut short (a version of several MB, over the free
plan's CPU time: the queue tried it four times, the worker's note before each try is what's left);
and, once per browser, a hint that a full backup is needed when backups are on and
none has ever run (tiddlers saved before they were set up aren't on GitHub otherwise). The request
and its answer go through the list sync ($:/cfworker/list-sync.js).
\*/
(function(){

"use strict";

exports.name = "cfworker-backup-alert";
exports.platforms = ["browser"];
exports.after = ["cfworker-list-sync"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

var BACKUP_ALERT = "$:/temp/cfworker/backup-alert",
	BACKUP_STUCK = "$:/temp/cfworker/backup-stuck",
	BACKUP_HINT = "$:/temp/cfworker/backup-hint",
	BACKUP_STATUS = "$:/temp/cfworker/backup-status",
	HINT_DISMISSED_KEY = "cfworker-backup-hint-dismissed",
	HINT_EMPTY_KEY = "cfworker-backup-hint-empty",         // the hint held back on an empty wiki, remembered (showHint)
	BACKUP_CHECK_MINUTES = 60;   // between asking how backups go ($:/config/cfworker/BackupCheckMinutes, the plugin's settings)

exports.startup = function() {
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || !Adaptor.prototype.cfworkerOnListRequest || Adaptor.prototype.cfworkerBackupAlert) {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		backupAsked = 0,          // when the worker last answered
		problemKey = null,        // the problem the alert is about (since + error): unchanged, nothing to redo, and a dismissed one stays dismissed
		stuckKey = null,          // the same for the backup cut short (title + started)
		syncRunning = false,      // a full backup is going: asked at each list request meanwhile
		removingHint = false;     // the hint being deleted by this module, not closed by the user
	proto.cfworkerBackupAlert = true;

	// Only the admin site asks (a public tab reads the list from the public site, which has no answer):
	// at the first request, at every request while an alert shows or a full backup runs, else once
	// the interval has passed (the setting, a minute at least: a nonsense value doesn't make every
	// request ask, which is an R2 read each)
	function askBackupStatus(adaptor) {
		if(!lib.onAdminSite(adaptor.host)) {
			return false;
		}
		var alertShown = wiki.tiddlerExists(BACKUP_ALERT) || wiki.tiddlerExists(BACKUP_STUCK),
			minutes = Math.max(1,parseInt(wiki.getTiddlerText("$:/config/cfworker/BackupCheckMinutes",""),10) || BACKUP_CHECK_MINUTES);
		return !backupAsked || syncRunning || alertShown || Date.now() - backupAsked >= minutes * 60 * 1000;
	}

	// The worker's answer, parsed: "off" (no backups), "ok", or encoded JSON with what there is to
	// say: the oldest failing backup {count, title, since, error, status}, stuck (a backup cut short:
	// {count, title, size, attempts, started, skipped}), sync (the last full backup), backups: "off". Returns
	// { backups, problem, stuck, sync } or null for an answer it can't read.
	function parseAnswer(answer) {
		if(answer === "ok" || answer === "off") {
			return {backups: answer === "ok" ? "on" : "off", problem: null, stuck: null, sync: null};
		}
		var report;
		try {
			report = JSON.parse(decodeURIComponent(answer));
		} catch(e) {
			return null;
		}
		if(!report || typeof report !== "object") {
			return null;
		}
		return {
			backups: report.backups === "off" ? "off" : "on",
			problem: report.count ? report : null,
			stuck: report.stuck && typeof report.stuck === "object" && report.stuck.title ? report.stuck : null,
			sync: report.sync && typeof report.sync === "object" ? report.sync : null
		};
	}
	function sizeText(bytes) {
		return typeof bytes === "number" && bytes >= 0 ? (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB") : "?";
	}

	function dateField(ms) {
		return ms ? $tw.utils.stringifyDate(new Date(ms)) : undefined;
	}

	// What there is to say about backups that keep failing, for the alert and the tab alike (wikitext).
	// problem: {count, title, since, error, status, next, direct} of the oldest
	// Each hint ends where the fix is: the token page and the secret (401), the check that tells a
	// missing repository from a missing branch (403, 404), the tiddler to edit and the key to revoke
	// (409, 422: GitHub refuses that version for good, so nothing retries it usefully until it changes)
	var TOKENS = "Settings → Developer settings → Personal access tokens → Fine-grained tokens",
		VARS = "in the worker's Settings → Variables and Secrets";
	function hintFor(problem) {
		if(problem.status === 401) {
			return "The token in the worker's GITHUB_TOKEN secret is wrong or has expired. On GitHub (" + TOKENS + "), regenerate it (it keeps its repository and permission) or make a new one as in " + lib.guide("setup","2.4") + " (Contents: read and write, this repository only; the guide's link opens GitHub's form filled in), then replace the GITHUB_TOKEN secret, " + VARS + ".";
		}
		if(problem.status === 403 || problem.status === 404) {
			return "Check the setup, in <$link to=\"$:/temp/cfworker/ControlPanel\">the Cloudflare tab</$link>, tells a missing repository or branch; if it passes, the token lacks Contents: read and write on that repository (" + lib.guide("setup","2.4") + ").";
		}
		if(problem.status === 409 || problem.status === 422) {
			return "GitHub refuses this version of the tiddler for good: its push protection found what looks like a secret (a key, a token) in the text, or its title makes a path GitHub can't take. On a public wiki the tiddler is readable by anyone: revoke that key, then remove it from the tiddler (or rename the tiddler) and save it again; the other backups go on meanwhile, and this one is tried again at the tiddler's next save.";
		}
		return "GitHub, or the way to it, may be down.";
	}
	function problemText(problem) {
		var hint = hintFor(problem),
			refusal = problem.status === 409 || problem.status === 422,
			// What becomes of them: the next try, when known (the time the queue was asked to deliver the
			// oldest again; kept current by the tab's line, the alert keeps its first), or nothing retries
			// a direct backup's failure (no queue, design 2.36)
			retried = problem.direct ?
				"Not retried: this worker has no backup queue, or couldn't reach it (" + lib.guide("setup","2.3") + "). Once fixed, each tiddler is backed up at its next save; with the queue bound, <$link to=\"$:/ControlPanel\">Control Panel</$link> → Saving → Cloudflare → Back up everything to GitHub sends them all." :
				refusal ? "The wiki keeps this version meanwhile." :
				(typeof problem.next === "number" && problem.next > Date.now() ? "Next try: " + $tw.utils.formatDateString(new Date(problem.next),"DDth MMM YYYY 0hh:0mm") + ", by itself." : "They're retried by themselves.") +
				" The wiki keeps everything meanwhile." +
				(problem.status === 401 ? " Once the secret is replaced, Back up everything to GitHub, in <$link to=\"$:/temp/cfworker/ControlPanel\">the Cloudflare tab</$link>, sends the current versions now, those the queue dropped meanwhile included (" + lib.guide("limits","5") + "); the waiting ones still arrive afterwards, as history." : "");
		return "Backups to GitHub have been failing since " + $tw.utils.formatDateString(new Date(problem.since),"DDth MMM YYYY 0hh:0mm") + ": " +
			(problem.count > 1 ? problem.count + " tiddlers, " + lib.link(problem.title) + " the oldest, aren't" : lib.link(problem.title) + " isn't") +
			" backed up yet. GitHub answered: ``" + String(problem.error).replace(/`/g,"'").replace(/[\r\n]+/g," ") + "``. " + hint + " " + retried;
	}

	// $:/temp/cfworker/backup-status: backups ("on"/"off"), asked (when), the last full backup as
	// sync-* fields (id, phase, total, done, committed, removed, failed, started, updated, finished,
	// error), and the backups failing as problem-* fields (since, count, title, next, text: the
	// alert's sentence, which the tab shows in place of "every save is committed"), for the control
	// panel. An answer that says nothing of problems (a full backup's) leaves the problem-* fields as
	// they are; one that says there are none clears them
	function noteStatus(status) {
		var sync = status.sync, problem = status.problem,
			kept = problem === undefined ? wiki.getTiddler(BACKUP_STATUS) : null,
			fields = {
			title: BACKUP_STATUS,
			backups: status.backups,
			asked: dateField(Date.now()),
			"problem-since": problem ? dateField(problem.since) : kept ? kept.fields["problem-since"] : undefined,
			"problem-count": problem ? String(problem.count) : kept ? kept.fields["problem-count"] : undefined,
			"problem-title": problem ? String(problem.title) : kept ? kept.fields["problem-title"] : undefined,
			"problem-next": problem ? dateField(problem.next) : kept ? kept.fields["problem-next"] : undefined,
			"problem-text": problem ? problemText(problem) : kept ? kept.fields["problem-text"] : undefined,
			"sync-id": sync ? String(sync.id || "") : undefined,
			"sync-phase": sync ? String(sync.phase || "") : undefined,
			"sync-total": sync && sync.total !== undefined && sync.total !== null ? String(sync.total) : undefined,
			"sync-done": sync ? String(sync.done || 0) : undefined,
			"sync-committed": sync ? String(sync.committed || 0) : undefined,
			"sync-removed": sync ? String(sync.removed || 0) : undefined,
			"sync-failed": sync ? String(sync.failed || 0) : undefined,
			"sync-started": sync ? dateField(sync.startedAt) : undefined,
			"sync-updated": sync ? dateField(sync.updatedAt) : undefined,
			"sync-finished": sync ? dateField(sync.finished) : undefined,
			"sync-running": sync ? (sync.running ? "yes" : "no") : undefined,
			"sync-error": sync && sync.error ? String(sync.error) : undefined
		};
		wiki.addTiddler(new $tw.Tiddler(fields));
		syncRunning = !!sync && !!sync.running;
	}

	// The alert while backups keep failing. problem: {count, title, since, error, status} of the oldest
	function showProblem(problem) {
		if(!problem) {
			problemKey = null;
			if(wiki.tiddlerExists(BACKUP_ALERT)) {
				wiki.deleteTiddler(BACKUP_ALERT);
			}
			return;
		}
		// The same problem as the alert is about: shown, it stays as it is (every list request asks
		// meanwhile, and rewriting it at each answer would change its date and refresh it for nothing);
		// dismissed, it stays dismissed
		var key = problem.since + " " + problem.error;
		if(key === problemKey) {
			return;
		}
		problemKey = key;
		wiki.addTiddler(new $tw.Tiddler({
			title: BACKUP_ALERT,
			tags: ["$:/tags/Alert"],
			component: "GitHub backup",
			modified: new Date(),
			text: problemText(problem)
		}));
	}

	// The alert for a backup the runtime cut short. stuck: {count, title, size, attempts, started,
	// skipped} of the oldest. Nothing retries it (the queue dropped it): the next save of the tiddler
	// does; a full backup cut short on it once skips it when its step is delivered again (skipped), and
	// goes on without it (design 2.37)
	function showStuck(stuck) {
		if(!stuck) {
			stuckKey = null;
			if(wiki.tiddlerExists(BACKUP_STUCK)) {
				wiki.deleteTiddler(BACKUP_STUCK);
			}
			return;
		}
		var key = stuck.title + " " + stuck.started + (stuck.skipped ? " skipped" : "");
		if(key === stuckKey) {
			return;
		}
		stuckKey = key;
		// The remedy by the tiddler's kind, from the fields the tab has: a plugin can be installed again
		// from where it came from; an image is better kept outside the wiki, the tiddler pointing at it
		// (TiddlyWiki's external images); anything else is split. A paid plan does for all
		var fields = (wiki.getTiddler(stuck.title) || {fields: {}}).fields,
			remedy = fields["plugin-type"] ? "A plugin can be installed again from where it came from, so GitHub missing this version costs little; or move the worker to a paid plan" :
				/^image\//.test(fields.type || "") ? "An image this size is better kept outside the wiki, the tiddler pointing at it with _canonical_uri (TiddlyWiki's external images); or move the worker to a paid plan" :
				"Split it, or move the worker to a paid plan";
		wiki.addTiddler(new $tw.Tiddler({
			title: BACKUP_STUCK,
			tags: ["$:/tags/Alert"],
			component: "GitHub backup",
			modified: new Date(),
			text: "The backup of " + lib.link(stuck.title) + " (" + sizeText(stuck.size) + ") was cut short" +
				(stuck.skipped ? ", and the full backup went past it" : " " + stuck.attempts + " times and dropped") +
				(stuck.count > 1 ? ", and " + (stuck.count - 1) + " more like it" : "") + ": most likely the free plan's CPU time ran out on a tiddler this size (" + lib.guide("limits","5") + "). " +
				"GitHub keeps the last version of it that went through, if one did; the wiki keeps this one. " +
				(stuck.skipped ? remedy + ", then run the full backup again (Back up everything to GitHub, in <$link to=\"$:/temp/cfworker/ControlPanel\">the Cloudflare tab</$link>)." :
					"It's tried again at the next save of it: " + remedy.charAt(0).toLowerCase() + remedy.slice(1) + ".")
		}));
	}

	// Once per browser: backups are on and no full backup has ever run. Closing the alert is
	// remembered on this device (localStorage); a full backup makes it moot everywhere.
	function hintDismissed() {
		try {
			return !!window.localStorage && (window.localStorage.getItem(HINT_DISMISSED_KEY) === "yes" || window.localStorage.getItem(HINT_EMPTY_KEY) === "yes");
		} catch(e) {
			return false;
		}
	}

	// (Not while backups fail, which the status tiddler says after noteStatus: the hint would sit under
	// the alert saying every save is committed; removed by the module, back once they're through.)
	// listEmpty: the list the worker just answered was "[]" (the list request's hook, below). An empty
	// wiki has nothing saved before backups were set up, so the hint would ask for a full backup it
	// doesn't need, on the first screen, and a full backup then makes GitHub mirror the empty bucket:
	// held back, and that is remembered on this device, so it doesn't come back once the first saves,
	// all backed up, fill the list
	function showHint(status,listEmpty) {
		var noted = wiki.getTiddler(BACKUP_STATUS);
		if(status.backups !== "on" || status.sync || (noted && noted.fields["problem-since"])) {
			if(wiki.tiddlerExists(BACKUP_HINT)) {
				removingHint = true;
				wiki.deleteTiddler(BACKUP_HINT);
			}
			return;
		}
		if(hintDismissed() || wiki.tiddlerExists(BACKUP_HINT)) {
			return;
		}
		if(listEmpty === true) {
			try {
				window.localStorage.setItem(HINT_EMPTY_KEY,"yes");
			} catch(e) {}
			return;
		}
		wiki.addTiddler(new $tw.Tiddler({
			title: BACKUP_HINT,
			tags: ["$:/tags/Alert"],
			component: "GitHub backup",
			modified: new Date(),
			text: "Backups to GitHub are on: every save from now on is committed. Tiddlers saved before they were set up (an imported wiki, say) aren't on GitHub until a full backup runs, once: " +
				"<$button message='tm-cfworker-backup-sync'>Back up everything to GitHub</$button> (or later from <$link to=\"$:/temp/cfworker/ControlPanel\">the Cloudflare tab</$link>, first under Control Panel → Saving). " +
				"A wiki whose first tiddler was saved with backups on is all there.\n\n{{$:/temp/cfworker/backup-sync-message}}"
		}));
	}

	// The hint's close button deletes it: remembered. Not a deletion of this module's own (backups
	// reported off, or a full backup run): on again with none run, the hint is due again
	wiki.addEventListener("change",function(changes) {
		if(changes[BACKUP_HINT] && changes[BACKUP_HINT].deleted) {
			if(removingHint) {
				removingHint = false;
				return;
			}
			try {
				window.localStorage.setItem(HINT_DISMISSED_KEY,"yes");
			} catch(e) {}
		}
	});

	// What the worker said, from the list request's header (the whole picture) or from a full
	// backup's answers (control-panel.js: {backups: "on", sync}, the failing backups not known, left
	// as they are): the status noted, the alert and the hint shown or removed
	proto.cfworkerNoteBackupStatus = function(answer,listEmpty) {
		var status = typeof answer === "string" ? parseAnswer(answer) : answer;
		if(!status) {
			return;
		}
		noteStatus(status);
		if(status.problem !== undefined) {
			showProblem(status.problem);
		}
		if(status.stuck !== undefined) {
			showStuck(status.stuck);
		}
		showHint(status,listEmpty);
	};

	proto.cfworkerOnListRequest({
		headers: function(adaptor) {
			return askBackupStatus(adaptor) ? {"X-Backup-Status": "ask"} : null;
		},
		answer: function(xhr) {
			if(!xhr || !xhr.getResponseHeader) {
				return;
			}
			// A list the service worker answered from its cache (the network gone, design 1.11) carries
			// the answer it was cached with, already noted when it came: not the worker answering now
			if(xhr.getResponseHeader("X-Served-From") === "cache") {
				return;
			}
			var answer = xhr.getResponseHeader("X-Backup-Status");
			if(answer) {
				backupAsked = Date.now();
				// (Whether the list itself is "[]", a wiki with nothing stored: the hooks run before the
				// adaptor reads the list, so the titles it recorded last can't say; a stand-in or a
				// rebuilding answer isn't "[]")
				proto.cfworkerNoteBackupStatus(answer,xhr.status === 200 && typeof xhr.responseText === "string" && /^\s*\[\s*\]\s*$/.test(xhr.responseText));
			}
		}
	});
};

})();
