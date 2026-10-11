/*\
title: $:/cfworker/cold-start.js
type: application/javascript
module-type: startup

On the admin site, registers the service worker the worker serves (/sw.js?v=<its version>, baked
into the page as $:/cfworker/sw-url), so that after one visit online the wiki opens with no network
(design 1.11). Registered once per version: a page already controlled by that version asks the
browser nothing (a register() call checks the script again, a request). The public site, read-only
and served without the worker, registers nothing.
\*/
(function(){

"use strict";

exports.name = "cfworker-cold-start";
exports.platforms = ["browser"];
exports.after = ["load-modules"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

var SW_URL = "$:/cfworker/sw-url";

exports.startup = function() {
	if(typeof window === "undefined" || typeof navigator !== "object" || !("serviceWorker" in navigator)) {
		return;
	}
	if(!lib.onAdminSite(window.location.origin + "/")) {
		return;
	}
	var url = ($tw.wiki.getTiddlerText(SW_URL,"") || "").trim();
	if(!url) {
		return;
	}
	var wanted;
	try {
		wanted = new URL(url,window.location.href).href;
	} catch(e) {
		return;
	}
	var controller = navigator.serviceWorker.controller;
	if(controller && controller.scriptURL === wanted) {
		return;
	}
	// updateViaCache "all": the browser's own checks of the script, at navigations, go through its
	// cache, where the script is fresh for a day (the worker says so): no request per page load. A
	// new script has a new address anyway, which the page brings.
	navigator.serviceWorker.register(wanted,{updateViaCache: "all"}).catch(function(e) {
		console.warn("cfworker: the service worker couldn't be registered (the wiki still works, online):",e);
	});
};

})();
