/*\
title: $:/cfworker/backup-alert.js
type: application/javascript
module-type: startup

On the admin site, asks how backups to GitHub go, with the tiddler list request (the worker reads
the backup status only then, and answers in a header of the same response: no extra request), when
the page loads, then hourly, and at each request while the alert shows; and shows an alert while
they keep failing. The request and its answer go through the list sync ($:/cfworker/list-sync.js).
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
	BACKUP_CHECK_INTERVAL = 60 * 60 * 1000;

exports.startup = function() {
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || !Adaptor.prototype.cfworkerOnListRequest || Adaptor.prototype.cfworkerBackupAlert) {
		return;
	}
	var proto = Adaptor.prototype,
		wiki = $tw.wiki,
		publicBase = lib.publicBase(),
		backupAsked = 0,          // when the worker last answered
		backupProblem = null;     // the problem the alert was about, so a dismissed one stays dismissed
	proto.cfworkerBackupAlert = true;

	// Only the admin site asks (a public tab reads the list from the public site, which has no answer)
	function askBackupStatus(adaptor) {
		return !!publicBase && lib.siteOf(adaptor.host) !== lib.siteOf(publicBase) &&
			(!backupAsked || wiki.tiddlerExists(BACKUP_ALERT) || Date.now() - backupAsked >= BACKUP_CHECK_INTERVAL);
	}

	// answer: "ok", or the oldest failing backup as encoded JSON {count, title, since, error, status}
	function showBackupStatus(answer) {
		if(answer === "ok") {
			backupProblem = null;
			if(wiki.tiddlerExists(BACKUP_ALERT)) {
				wiki.deleteTiddler(BACKUP_ALERT);
			}
			return;
		}
		var problem;
		try {
			problem = JSON.parse(decodeURIComponent(answer));
		} catch(e) {
			return;
		}
		var key = problem.since + " " + problem.error;
		if(key === backupProblem && !wiki.tiddlerExists(BACKUP_ALERT)) {
			return;
		}
		backupProblem = key;
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
				" backed up yet. GitHub answered: ``" + String(problem.error).replace(/`/g,"'") + "``. " + hint +
				" They're retried by themselves, and the wiki keeps everything meanwhile."
		}));
	}

	proto.cfworkerOnListRequest({
		headers: function(adaptor) {
			return askBackupStatus(adaptor) ? {"X-Backup-Status": "ask"} : null;
		},
		answer: function(xhr) {
			var answer = xhr && xhr.getResponseHeader ? xhr.getResponseHeader("X-Backup-Status") : null;
			if(answer) {
				backupAsked = Date.now();
				showBackupStatus(answer);
			}
		}
	});
};

})();
