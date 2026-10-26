/*\
title: $:/cfworker/save-shortcut.js
type: application/javascript
module-type: startup

Ctrl+S on the admin site says saving is automatic (design 2.39). TiddlyWiki's save-wiki shortcut
sends tm-save-wiki, whose core listener asks the savers for "save", and the download saver answers
by downloading a copy of the page, wiki.html, then wiki (1).html, as a single-file wiki would. Here
every change goes to the worker as it's made: the two download savers (the only ones a browser can
use) stop offering "save" and keep "download", which the cloud icon's "Save snapshot for offline
use" still sends (tm-download-file), and a listener on tm-save-wiki shows a notification instead.
Listeners stack in TiddlyWiki 5.4, so a listener alone wouldn't stop the core's; the capabilities
do. Once at startup, nothing per save or per load. The public site isn't touched: the plugin is
the admin wiki's (design 2.21); and a snapshot opened from disk has no TiddlyWeb adaptor, so this
module leaves it as TiddlyWiki made it, Ctrl+S saving the file there.
\*/
(function(){

"use strict";

exports.name = "cfworker-save-shortcut";
exports.platforms = ["browser"];
exports.after = ["rootwidget"];   // ($tw.saverHandler is made by the core's "startup" task, which rootwidget follows)
exports.synchronous = true;

var lib = require("$:/cfworker/lib.js"),
	NOTE = "$:/plugins/cfworker/admin/saved-automatically";   // the notification's text, a part of the plugin

exports.startup = function() {
	var Adaptor = lib.findAdaptor();
	if(!Adaptor || Adaptor.prototype.cfworkerSaveShortcut || !$tw.saverHandler || !$tw.rootWidget) {
		return;
	}
	Adaptor.prototype.cfworkerSaveShortcut = true;
	$tw.utils.each($tw.saverHandler.savers,function(saver) {
		if(saver && saver.info && (saver.info.name === "download" || saver.info.name === "manualdownload")) {
			saver.info = {name: saver.info.name, priority: saver.info.priority, capabilities: ["download"]};
		}
	});
	$tw.rootWidget.addEventListener("tm-save-wiki",function() {
		$tw.rootWidget.dispatchEvent({type: "tm-notify", param: NOTE});
		return false;
	});
};

})();
