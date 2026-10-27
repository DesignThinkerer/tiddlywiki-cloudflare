/*\
title: $:/cfworker/cold-start.js
type: application/javascript
module-type: startup

Registers the service worker (/sw.js?v=<its version>, baked into the page as $:/cfworker/sw-url;
served by the worker on the admin site, a file of the bucket on the public one, registered there
with site=public), so that after one visit online the wiki opens with no network
(design 1.11). Registered once per version: a page already controlled by that version asks the
browser nothing (a register() call checks the script again, a request).
\*/
(function(){

"use strict";

exports.name = "cfworker-cold-start";
exports.platforms = ["browser"];
exports.after = ["load-modules"];
exports.before = ["startup"];
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js");

var SW_URL = "$:/cfworker/sw-url",
	NETWORK_WAIT = 8;   // s the service worker waits for the network before the kept page ($:/config/cfworker/NetworkWait, the plugin's settings)

exports.startup = function() {
	if(typeof window === "undefined" || typeof navigator !== "object" || !("serviceWorker" in navigator)) {
		return;
	}
	var url = ($tw.wiki.getTiddlerText(SW_URL,"") || "").trim();
	if(!url) {
		return;
	}
	// The same address on both sites: the worker serves the script on the admin site, the bucket on
	// the public one (written with the page), where the script is told which site it serves, since it
	// reads no tiddler (design 2.40). A public site whose worker hasn't rebuilt the page yet has no
	// file: the registration fails, warned below, and the site works online as before.
	var wanted;
	try {
		var address = new URL(url,window.location.href);
		if(!lib.onAdminSite(window.location.origin + "/")) {
			address.searchParams.set("site","public");
		}
		wanted = address.href;
	} catch(e) {
		return;
	}
	// The service worker reads no tiddler: the page tells it its setting at each load, once it's in
	// place (the first visit too, once it has activated), and it keeps it (service-worker.js)
	navigator.serviceWorker.ready.then(function(registration) {
		if(registration.active) {
			registration.active.postMessage({cfworker: "settings", networkWait: (parseInt($tw.wiki.getTiddlerText("$:/config/cfworker/NetworkWait",""),10) || NETWORK_WAIT) * 1000});
		}
	},function() {});
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
