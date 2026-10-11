/*\
The admin wiki's service worker (design 1.11): after one visit online, the wiki opens with no
network. Served by the worker at /sw.js?v=<its version>, registered by $:/cfworker/cold-start.js on
the admin site. Not a TiddlyWiki module: a plain script the browser runs outside the page.

By request:
- The page (a navigation, or /, /index.html, /baked.html): the network first, the cached page when
  the network fails or doesn't answer in time. Only an answer carrying the worker's own mark
  (X-Wiki-Page) is cached, so Cloudflare's login page, or the worker refusing a request, is shown as
  it is and never kept. Online, nothing changes.
- The core file and the plugin files (_plugins/<name>.js?v=<version>, on this site or the public
  one): the cache first; their address carries their version, so a copy is never stale. One from the
  public site is asked for with CORS (the zone's rule allows the admin site, README 2.7): a real
  answer, kept at its real size. Never an "opaque" one (a plain <script> load from another site):
  the browser charges those several megabytes each against the site's storage, whatever their size,
  and storage under pressure is evicted whole, the outbox with it. Without the CORS header the file
  isn't kept: the page's own <script> load still works online.
- The status file and the tiddler list: the network first, the cached one when the network fails,
  with X-Served-From: cache so the list sync knows (a device copy then counts whatever its revision).
- /favicon.ico: the browser asks for it at a navigation when the page has no icon link (TiddlyWiki
  sets its icon once started): answered here, empty, rather than by the worker.
- Anything else (a tiddler's contents, a save, a delete, the page published): the network only.
When a new page is cached, the plugin files it no longer refers to leave the cache.
\*/
(function() {

"use strict";

var CACHE = "cfworker-wiki-v1",
	MARK = "X-Wiki-Page",
	FROM = "X-Served-From",
	PAGE_PATHS = ["/", "/index.html", "/baked.html"],
	PAGE_KEY = self.location.origin + "/",
	NETWORK_WAIT = 8000;   // ms before the cached page answers instead of a network that doesn't

self.addEventListener("install", function() {
	self.skipWaiting();
});

// Older caches of ours go; this version takes the open pages over at once
self.addEventListener("activate", function(event) {
	event.waitUntil(caches.keys().then(function(names) {
		return Promise.all(names.filter(function(name) {
			return name.indexOf("cfworker-wiki-") === 0 && name !== CACHE;
		}).map(function(name) {
			return caches.delete(name);
		}));
	}).then(function() {
		return self.clients.claim();
	}));
});

function isPage(request,url) {
	return url.origin === self.location.origin && (request.mode === "navigate" || PAGE_PATHS.indexOf(url.pathname) >= 0);
}
function isFile(url) {
	return /\/_plugins\/[^/]+\.js$/.test(url.pathname) && url.searchParams.has("v");
}
function isData(url) {
	return url.origin === self.location.origin && (url.pathname === "/status" || url.pathname === "/recipes/default/tiddlers.json");
}

self.addEventListener("fetch",function(event) {
	var request = event.request;
	if(request.method !== "GET") {
		return;
	}
	var url = new URL(request.url);
	if(isPage(request,url)) {
		event.respondWith(networkFirst(event,request,PAGE_KEY,true));
	} else if(url.origin === self.location.origin && url.pathname === "/favicon.ico") {
		event.respondWith(new Response(null,{status: 204}));
	} else if(isFile(url)) {
		event.respondWith(cacheFirst(request));
	} else if(isData(url)) {
		event.respondWith(networkFirst(event,request,request.url,false));
	}
});

// The same response with a header added (a cached one, served because the network didn't answer)
function withHeader(response,name,value) {
	var headers = new Headers(response.headers);
	headers.set(name,value);
	return new Response(response.body,{status: response.status, statusText: response.statusText, headers: headers});
}

function fromCache(key,page) {
	return caches.open(CACHE).then(function(cache) {
		return cache.match(key);
	}).then(function(hit) {
		return hit ? (page ? hit : withHeader(hit,FROM,"cache")) : null;
	});
}

// The network, with the cached answer when it fails or takes too long; a good answer is kept (for
// the page, only one that carries the worker's mark)
function networkFirst(event,request,key,page) {
	return new Promise(function(resolve) {
		var done = false,
			timer = null;
		function serve(response) {
			if(!done) {
				done = true;
				clearTimeout(timer);
				resolve(response);
			}
		}
		var fetching = fetch(request).then(function(response) {
			if(response && response.ok && (!page || response.headers.get(MARK))) {
				var forCache = response.clone(),
					forPrune = page ? response.clone() : null;
				event.waitUntil(caches.open(CACHE).then(function(cache) {
					return cache.put(key,forCache).then(function() {
						return forPrune ? forPrune.text().then(function(html) {
							return prune(cache,html);
						}) : null;
					});
				}).catch(function() {}));
			}
			return response;
		});
		event.waitUntil(fetching.catch(function() {}));
		timer = setTimeout(function() {
			fromCache(key,page).then(function(hit) {
				if(hit) {
					serve(hit);
				}
			});
		},NETWORK_WAIT);
		fetching.then(serve,function() {
			fromCache(key,page).then(function(hit) {
				if(hit) {
					return serve(hit);
				}
				serve(new Response("No network, and no copy of the wiki kept on this device yet: open it once online first.",{status: 503, headers: {"Content-Type": "text/plain; charset=utf-8"}}));
			});
		});
	});
}

// The cache, else the network, kept if it answered ok. A file on another site (the public one) is
// asked for with CORS, so the answer can be seen and is stored at its real size; if that site doesn't
// allow it, the page's own plain request goes out instead, and nothing is kept.
function cacheFirst(request) {
	var url = request.url,
		sameSite = new URL(url).origin === self.location.origin;
	return caches.open(CACHE).then(function(cache) {
		return cache.match(url).then(function(hit) {
			if(hit) {
				return hit;
			}
			// (Past the browser's own cache: a copy it took before the site allowed CORS has no
			// permission in it, and such a file is kept for a year)
			var asked = sameSite ? fetch(request) : fetch(new Request(url,{mode: "cors", credentials: "omit", cache: "reload"})).catch(function() {
				return null;
			});
			return asked.then(function(response) {
				if(response && response.ok) {
					cache.put(url,response.clone()).catch(function() {});
					return response;
				}
				return response || fetch(request);
			});
		});
	});
}

// The core file and plugin files the page loads: any other such file in the cache goes
function prune(cache,html) {
	var keep = Object.create(null),
		pattern = /<script src="([^"]*\/_plugins\/[^"]*)"/g,
		found;
	while((found = pattern.exec(html)) !== null) {
		keep[new URL(found[1],PAGE_KEY).href] = true;
	}
	return cache.keys().then(function(requests) {
		return Promise.all(requests.filter(function(cached) {
			var url = new URL(cached.url);
			return isFile(url) && !keep[cached.url];
		}).map(function(cached) {
			return cache["delete"](cached);
		}));
	});
}

})();
