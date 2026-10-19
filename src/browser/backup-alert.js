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
	// {count, title, size, attempts, started}), sync (the last full backup), backups: "off". Returns
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

	// $:/temp/cfworker/backup-status: backups ("on"/"off"), asked (when), and the last full backup
	// as sync-* fields (id, phase, total, done, committed, removed, failed, started, updated,
	// finished, error), for the control panel
	function noteStatus(status) {
		var sync = status.sync, fields = {
			title: BACKUP_STATUS,
			backups: status.backups,
			asked: dateField(Date.now()),
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
		var hint = problem.status === 401 ? "The token in the worker's GITHUB_TOKEN secret is wrong or has expired: make a new one and put it in the secret." :
			problem.status === 403 || problem.status === 404 ? "The token may not be allowed to write to the repository in GITHUB_REPO, or the repository or its branch doesn't exist." :
			problem.status === 409 || problem.status === 422 ? "GitHub refuses that file." :
			"GitHub, or the way to it, may be down.";
		wiki.addTiddler(new $tw.Tiddler({
			title: BACKUP_ALERT,
			tags: ["$:/tags/Alert"],
			component: "GitHub backup",
			modified: new Date(),
			text: "Backups to GitHub have been failing since " + $tw.utils.formatDateString(new Date(problem.since),"DDth MMM YYYY 0hh:0mm") + ": " +
				(problem.count > 1 ? problem.count + " tiddlers, " + lib.link(problem.title) + " the oldest, aren't" : lib.link(problem.title) + " isn't") +
				" backed up yet. GitHub answered: ``" + String(problem.error).replace(/`/g,"'").replace(/[\r\n]+/g," ") + "``. " + hint +
				" They're retried by themselves, and the wiki keeps everything meanwhile."
		}));
	}

	// The alert for a backup the runtime cut short. stuck: {count, title, size, attempts, started}
	// of the oldest. Nothing retries it (the queue dropped it): the next save of the tiddler does.
	function showStuck(stuck) {
		if(!stuck) {
			stuckKey = null;
			if(wiki.tiddlerExists(BACKUP_STUCK)) {
				wiki.deleteTiddler(BACKUP_STUCK);
			}
			return;
		}
		var key = stuck.title + " " + stuck.started;
		if(key === stuckKey) {
			return;
		}
		stuckKey = key;
		wiki.addTiddler(new $tw.Tiddler({
			title: BACKUP_STUCK,
			tags: ["$:/tags/Alert"],
			component: "GitHub backup",
			modified: new Date(),
			text: "The backup of " + lib.link(stuck.title) + " (" + sizeText(stuck.size) + ") was cut short " + stuck.attempts + " times and dropped" +
				(stuck.count > 1 ? ", and " + (stuck.count - 1) + " more like it" : "") + ": most likely the free plan's CPU time ran out on a tiddler this size (" + lib.guide("limits","5") + "). " +
				"GitHub keeps the last version of it that went through; the wiki keeps this one. It's tried again at the next save of it: split it, or move the worker to a paid plan."
		}));
	}

	// Once per browser: backups are on and no full backup has ever run. Closing the alert is
	// remembered on this device (localStorage); a full backup makes it moot everywhere.
	function hintDismissed() {
		try {
			return !!window.localStorage && window.localStorage.getItem(HINT_DISMISSED_KEY) === "yes";
		} catch(e) {
			return false;
		}
	}

	function showHint(status) {
		if(status.backups !== "on" || status.sync) {
			if(wiki.tiddlerExists(BACKUP_HINT)) {
				removingHint = true;
				wiki.deleteTiddler(BACKUP_HINT);
			}
			return;
		}
		if(hintDismissed() || wiki.tiddlerExists(BACKUP_HINT)) {
			return;
		}
		wiki.addTiddler(new $tw.Tiddler({
			title: BACKUP_HINT,
			tags: ["$:/tags/Alert"],
			component: "GitHub backup",
			modified: new Date(),
			text: "Backups to GitHub are on: every save from now on is committed. Tiddlers saved before they were set up (an imported wiki, say) aren't on GitHub until a full backup runs, once: " +
				"<$link to=\"$:/ControlPanel\">Control Panel</$link> → Saving → Cloudflare → Back up everything to GitHub."
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
	proto.cfworkerNoteBackupStatus = function(answer) {
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
		showHint(status);
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
				proto.cfworkerNoteBackupStatus(answer);
			}
		}
	});
};

})();
