/*\
title: $:/cfworker/public-site.js
type: application/javascript
module-type: startup

The public site's cloud icon (design 2.41). TiddlyWeb's Login item led to its own prompt ("Login to
TiddlySpace") and nowhere, the public site having no login: it's replaced by a link to the admin site,
the address the worker baked into the page ($:/cfworker/admin-url, the origin the shell was published
from, behind the one Access application), or by nothing on a page built before that address was
known. And a line that says offline, in the admin site's words, from the list sync's word that the
list came from the service worker's copy (X-Served-From: cache) rather than the site. Nothing on the
admin site, where Access's page is the login and the outbox's item says offline.
\*/
(function(){

"use strict";

exports.name = "cfworker-public-site";
exports.platforms = ["browser"];
exports.after = ["cfworker-list-sync"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js"),
	LOGIN_ITEM = "$:/plugins/tiddlywiki/tiddlyweb/syncer-actions/login",
	ADMIN_URL = "$:/cfworker/admin-url",
	STATUS = "$:/temp/cfworker/public-status",   // online: yes or no, from the last list
	ITEM = "$:/temp/cfworker/public-offline",
	OFFLINE_LINE = "Offline: what this device has loaded is here; a tiddler never opened on it is empty, and changes made elsewhere come when the network is back.";

exports.startup = function() {
	if(typeof window === "undefined" || lib.onAdminSite(window.location.origin + "/")) {
		return;
	}
	var wiki = $tw.wiki,
		admin = (wiki.getTiddlerText(ADMIN_URL,"") || "").trim();
	// The override of TiddlyWeb's item: a real tiddler over the shadow, which the read-only adaptor
	// never sends and the device copy never keeps (it isn't listed)
	wiki.addTiddler(new $tw.Tiddler({
		title: LOGIN_ITEM,
		tags: admin ? ["$:/tags/SyncerDropdown"] : [],
		text: admin ? "<a class=\"tc-btn-invisible tc-tiddlylink-external\" href=\"" + admin + "\" target=\"_blank\" rel=\"noopener noreferrer\">{{$:/core/images/unlocked-padlock}} Log in to edit</a>" : ""
	}));
	wiki.addTiddler(new $tw.Tiddler({
		title: ITEM,
		tags: ["$:/tags/SyncerDropdown"],
		"list-after": LOGIN_ITEM,
		text: "<$list filter='[[" + STATUS + "]get[online]match[no]]' variable='off'><div class='tc-drop-down-info cfworker-outbox'>" + OFFLINE_LINE + "</div><hr/></$list>"
	}));
	var Adaptor = lib.findAdaptor();
	if(Adaptor && typeof Adaptor.prototype.cfworkerOnList === "function") {
		Adaptor.prototype.cfworkerOnList(function(listed,previous,entries,fromCache) {
			var online = fromCache ? "no" : "yes",
				current = wiki.getTiddler(STATUS);
			if(!current || current.fields.online !== online) {
				wiki.addTiddler(new $tw.Tiddler({title: STATUS, online: online}));
			}
		});
	}
};

})();
