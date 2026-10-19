/*\
title: $:/cfworker/release-check.js
type: application/javascript
module-type: widget

<$cfworker-release/>, at the top of the control panel's Cloudflare tab ($:/cfworker/control-panel.js),
renders nothing and does one thing when the tab is shown: asks GitHub's releases API for this
repository's newest release (design 1.17) — from the browser, no token (a public repository),
nothing through the worker — at most once a day per browser (the answer kept in localStorage),
compares it with the worker's version (the plugin's: package.json's date, then a build hash) and
writes what the tab says in $:/temp/cfworker/release: a newer release, with the link to its notes
and to operating 3.1; this one the newest; this one newer than the newest (a copy synced past it);
GitHub not answering, said with why and asked again at the next showing.
\*/
(function(){

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget,
	lib = require("$:/cfworker/lib.js");

var RELEASE = "$:/temp/cfworker/release",
	PLUGIN = "$:/plugins/cfworker/admin",
	KEY = "cfworker-release",   // localStorage: the last answer, {at, latest, url} or {at, error}
	API = "https://api.github.com/repos/DesignThinkerer/tiddlywiki-cloudflare/releases/latest",   // (the tests point the page at a stand-in before boot, $tw.cfworkerReleasesApi: test/browser-harness.mjs; nothing stored in a wiki can, as with the waits, design 2.25)
	RELEASES = lib.REPO_URL + "/releases",
	DAY = 24 * 60 * 60 * 1000,
	CHECKED = "<$view tiddler='" + RELEASE + "' field='checked' format='date' template='0hh:0mm'/>",
	asking = false;   // one request at a time, however often the tab is shown meanwhile

// The worker's version, from the plugin's: package.json's date before the "+", the build hash after
function workerVersion() {
	var plugin = $tw.wiki.getTiddler(PLUGIN),
		full = plugin ? String(plugin.fields.version || "") : "",
		plus = full.indexOf("+");
	return { version: plus >= 0 ? full.slice(0,plus) : full, build: plus >= 0 ? full.slice(plus + 1) : "" };
}

// A version's numbers ("v2026.10.19", "2026.10.19+k3j2": [2026, 10, 19]), or null for what isn't one
function numbers(version) {
	var m = /^v?(\d+(?:\.\d+)*)/.exec(String(version || ""));
	return m ? m[1].split(".").map(Number) : null;
}
// -1 when a is before b, 0 the same, 1 after; null when either isn't a version
function compare(a,b) {
	var x = numbers(a), y = numbers(b);
	if(!x || !y) {
		return null;
	}
	for(var i = 0; i < Math.max(x.length,y.length); i++) {
		var p = x[i] || 0, q = y[i] || 0;
		if(p !== q) {
			return p < q ? -1 : 1;
		}
	}
	return 0;
}

function recall() {
	try {
		var record = JSON.parse(window.localStorage.getItem(KEY) || "null");
		return record && typeof record === "object" && record.at ? record : null;
	} catch(e) {
		return null;
	}
}
function remember(record) {
	try {
		window.localStorage.setItem(KEY,JSON.stringify(record));
	} catch(e) {}
}

// $:/temp/cfworker/release: the worker's version and build (control-panel.js writes them at startup,
// kept here), state (checking, newer, same, ahead, failed), latest and url (GitHub's), checked, error,
// and the line the tab shows as its text. Written only when something changes: each write refreshes
// the tab.
function note(fields) {
	var wiki = $tw.wiki, existing = wiki.getTiddler(RELEASE), same = !!existing;
	$tw.utils.each(fields,function(value,name) {
		if(same && String(existing.fields[name] || "") !== String(value || "")) {
			same = false;
		}
	});
	if(same) {
		return;
	}
	wiki.addTiddler(new $tw.Tiddler(workerVersion(),existing ? existing.fields : {},fields,{title: RELEASE}));
}

// What the tab says for an answer: {at, latest, url} or {at, error}
function show(record) {
	var checked = $tw.utils.stringifyDate(new Date(record.at)),
		failed = function(error) {
			note({state: "failed", error: String(error), checked: checked,
				text: "GitHub couldn't be asked for the newest release: <code><$text text={{" + RELEASE + "!!error}}/></code>. Its [[releases page|" + RELEASES + "]] has it; asked again the next time this tab is shown."});
		};
	if(record.error) {
		return failed(record.error);
	}
	var mine = workerVersion().version,
		order = compare(record.latest,mine),
		link = "[[" + record.latest + "|" + record.url + "]]";
	if(order === null) {
		return failed("the versions couldn't be compared (" + record.latest + " and " + mine + ")");
	}
	note({
		state: order > 0 ? "newer" : order === 0 ? "same" : "ahead",
		latest: record.latest, url: record.url, checked: checked, error: undefined,
		text: order > 0 ? "A newer release is out: " + link + " (the link opens its notes). To take it, update your copy (" + lib.guide("operating","3.1") + "): Workers Builds redeploys, and the next page load runs it." :
			order === 0 ? "This is the newest release, checked at " + CHECKED + "." :
			"Newer than the newest release (" + link + "): a copy synced past it. Checked at " + CHECKED + "."
	});
}

// GitHub asked; the answer, or the failure, remembered and shown
function ask() {
	if(asking) {
		return;
	}
	asking = true;
	note({state: "checking", text: "Asking GitHub for the newest release…"});
	var done = function(record) {
		asking = false;
		remember(record);
		show(record);
	};
	var answered = function(response) {
		return response.text().then(function(body) {
			var data = null;
			try {
				data = JSON.parse(body);
			} catch(e) {}
			if(!response.ok) {
				return done({at: Date.now(), error: "GitHub answered " + response.status + (data && data.message ? ": " + String(data.message).replace(/\.$/,"") : "")});
			}
			if(!data || !numbers(data.tag_name)) {
				return done({at: Date.now(), error: "GitHub's answer couldn't be read"});
			}
			var url = String(data.html_url || "");
			done({at: Date.now(), latest: String(data.tag_name).replace(/^v/,""), url: url.indexOf(lib.REPO_URL + "/") === 0 ? url : RELEASES});
		});
	};
	var failed = function(err) {
		done({at: Date.now(), error: "no answer (" + ((err && err.message) || "network") + ")"});
	};
	try {
		// Accept alone: a request the browser sends without asking GitHub first, which allows any site
		fetch(typeof $tw.cfworkerReleasesApi === "string" && $tw.cfworkerReleasesApi ? $tw.cfworkerReleasesApi : API,{headers: {Accept: "application/vnd.github+json"}, cache: "no-store", credentials: "omit"}).then(answered,failed).catch(failed);
	} catch(e) {
		failed(e);
	}
}

// When the tab is shown: the remembered answer when it's a good one less than a day old, else GitHub
function check() {
	var record = recall();
	if(record && !record.error && Date.now() - record.at < DAY) {
		show(record);
		return;
	}
	ask();
}

var ReleaseWidget = function(parseTreeNode,options) {
	this.initialise(parseTreeNode,options);
};
ReleaseWidget.prototype = new Widget();
// Nothing in the page: the tab shows $:/temp/cfworker/release itself
ReleaseWidget.prototype.render = function(parent,nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();
	if(typeof window !== "undefined" && typeof fetch === "function") {
		check();
	}
};
ReleaseWidget.prototype.execute = function() {};
ReleaseWidget.prototype.refresh = function() {
	return false;
};

exports["cfworker-release"] = ReleaseWidget;

})();
