/*\
title: $:/cfworker/restore-import.js
type: application/javascript
module-type: startup

Imports the backup's files (setup 2.4). On GitHub, tiddlers/<title>.json is the tiddler as the
worker stores it: TiddlyWeb's layout, with the tags as a list, a custom field called "fields"
nested, and the revision, bag and recipe of the wiki it came from. TiddlyWiki's JSON import keeps
only the fields whose value is text, so such a file dropped onto the wiki would lose every tag.
This module takes those files over (TiddlyWiki's th-importing-file hook, which a drop, a paste and
the import button all go through) and hands the import dialog each tiddler with every field as
text, without the old revision, bag and recipe. Any other file is read as TiddlyWiki reads it.
\*/
(function(){

"use strict";

exports.name = "cfworker-restore-import";
exports.platforms = ["browser"];
exports.before = ["startup"];
exports.synchronous = true;

// A stored tiddler, or a file of them: a title, and what TiddlyWiki's JSON import would mangle or
// what only the worker writes (the revision, bag and recipe; tags as a list; nested fields)
function isStored(data) {
	var items = Array.isArray(data) ? data : [data];
	return items.length > 0 && items.every(function(item) {
		return !!item && typeof item === "object" && !Array.isArray(item) && typeof item.title === "string" &&
			(typeof item.revision === "string" || typeof item.bag === "string" || Array.isArray(item.tags) ||
			 (!!item.fields && typeof item.fields === "object"));
	});
}

// The tiddler as the import takes it: every field as text (a list as TiddlyWiki writes one), the
// nested fields flat, without the revision, bag and recipe
function importable(stored) {
	var fields = {};
	$tw.utils.each(stored,function(value,name) {
		if(name === "revision" || name === "bag" || name === "recipe") {
			return;
		}
		if(name === "fields" && value && typeof value === "object" && !Array.isArray(value)) {
			$tw.utils.each(value,function(nested,nestedName) {
				if(typeof nested === "string") {
					fields[nestedName] = nested;
				}
			});
		} else if(typeof value === "string") {
			fields[name] = value;
		} else if(Array.isArray(value)) {
			fields[name] = $tw.utils.stringifyList(value.map(String));
		} else if(typeof value === "number" || typeof value === "boolean") {
			fields[name] = String(value);
		}
	});
	return fields;
}

exports.startup = function() {
	if(!$tw.browser || !$tw.hooks || typeof FileReader === "undefined") {
		return;
	}
	$tw.hooks.addHook("th-importing-file",function(info) {
		// (Hooks are chained: a handler before this one may have taken the file, or left something else)
		if(!info || typeof info !== "object" || !info.file || typeof info.callback !== "function" ||
		   (info.type !== "application/json" && !/\.json$/i.test(info.file.name || ""))) {
			return info;
		}
		var readAsUsual = function() {
			$tw.wiki.readFileContent(info.file,info.type,info.isBinary,undefined,info.callback);
		};
		var reader = new FileReader();
		reader.onload = function(event) {
			var data;
			try {
				data = JSON.parse(event.target.result);
			} catch(e) {
				data = undefined;
			}
			if(data === undefined || !isStored(data)) {
				readAsUsual();
				return;
			}
			var tiddlers = [];
			$tw.utils.each(Array.isArray(data) ? data : [data],function(item) {
				tiddlers.push(importable(item));
			});
			info.callback(tiddlers);
		};
		reader.onerror = readAsUsual;
		reader.readAsText(info.file);
		return true;
	});
};

})();
