/*\
title: $:/cfworker/lib.js
type: application/javascript
module-type: library

What the worker's browser modules share: the sync adaptor they patch, the public site's address,
titles in alerts, the titles the worker can't store, and the "rebuilding" answer. Each module
requires this one.
\*/
(function(){

"use strict";

// The TiddlyWeb sync adaptor's class (the modules patch its prototype), or null without it
exports.findAdaptor = function() {
	var Adaptor = null;
	$tw.modules.forEachModuleOfType("syncadaptor",function(title,module) {
		if(module.adaptorClass && module.adaptorClass.prototype.name === "tiddlyweb") {
			Adaptor = module.adaptorClass;
		}
	});
	return Adaptor;
};

// The public site's address, with a trailing slash, as the worker baked it into the page ("" if none)
exports.publicBase = function() {
	var base = ($tw.wiki.getTiddlerText("$:/cfworker/public-url","") || "").trim();
	if(base && base.charAt(base.length - 1) !== "/") {
		base += "/";
	}
	return base;
};

// The site a URL is on, whatever the protocol: the public site visited over http while its URL says
// https (or the other way round) is still the public site
exports.siteOf = function(url) {
	return String(url || "").replace(/^[a-z][a-z0-9+.-]*:/i,"").toLowerCase();
};

// A wikitext attribute value holding the text as it is (in quotes it doesn't contain), or null
function attributeValue(text) {
	if(text.indexOf('"') === -1) {
		return '"' + text + '"';
	}
	if(text.indexOf("'") === -1) {
		return "'" + text + "'";
	}
	if(text.indexOf('"""') === -1 && text.charAt(text.length - 1) !== '"') {
		return '"""' + text + '"""';
	}
	return null;
}

// A link to a tiddler in an alert, whatever its title: a [[...]] link would break on one ending in
// "]" or holding "]]" or "|", and the title is shown as text, never rendered as wikitext
exports.link = function(title) {
	var value = attributeValue(title);
	return value ? "<$link to=" + value + "><$text text=" + value + "/></$link>" : "'" + title + "'";
};

// The longest title the worker stores: an R2 key holds 1024 bytes, 25 of them before the title
exports.MAX_TITLE_BYTES = 999;

exports.utf8Length = function(text) {
	return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
};

// Titles the worker can't store, so never sent: "." and ".." (the browser takes them, in a URL, for
// the folder or its parent, so they'd never get there) and those too long for an R2 key
exports.storableTitle = function(title) {
	return title !== "." && title !== ".." && (title.length * 3 <= exports.MAX_TITLE_BYTES || exports.utf8Length(title) <= exports.MAX_TITLE_BYTES);
};

// While the worker rebuilds a damaged tiddler list (a step per request), it answers the list,
// saves and deletes with 503 and "X-Tiddler-List: rebuilding", without changing anything: the
// request is simply sent again, quietly (TiddlyWiki would show an error and wait 5 seconds).
// Any other error is reported as usual.
exports.REBUILD_RETRIES = 200;

exports.isRebuilding = function(request) {
	return !!request && request.status === 503 && request.getResponseHeader("X-Tiddler-List") === "rebuilding";
};

})();
