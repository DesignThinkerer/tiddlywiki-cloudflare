/*\
The wiki's service worker (design 1.11, 2.40): after one visit online, the wiki opens with no
network. On the admin site, served by the worker at /sw.js?v=<its version>; on the public site, the
same script as a file of the bucket, written with the page, registered as /sw.js?v=<version>&site=public.
Registered by $:/cfworker/cold-start.js on both. Not a TiddlyWiki module: a plain script the browser
runs outside the page. Which site it serves it reads from its own address (site=public): it reads no
tiddler.

By request:
- The page (a navigation, or /, /index.html, /baked.html). On the admin site, the network first, the
  cached page when the network fails or doesn't answer in time. Only an answer carrying the worker's
  own mark (X-Wiki-Page) is cached, so Cloudflare's login page, or the worker refusing a request, is
  shown as it is and never kept. Online, nothing changes. On the public site, where no login wall can
  make a kept page lie, the kept page at once and the current one fetched behind it for the next load
  (stale while revalidate): the page is the slow part of a weak signal, and what changed in the wiki
  comes through the list. The bucket adds no header, so there a page is kept only when its text
  carries the plugin's sw-url tiddler, which Cloudflare's error pages and interstitials never do. A
  page served stale isn't one the network wait ran out on: its first list goes to the network as usual.
- The core file and the plugin files (_plugins/<name>.js?v=<version>, on this site or the public
  one): the cache first; their address carries their version, so a copy is never stale. One from the
  public site is asked for with CORS (the zone's rule allows the admin site, setup 2.7): a real
  answer, kept at its real size. Never an "opaque" one (a plain <script> load from another site):
  the browser charges those several megabytes each against the site's storage, whatever their size,
  and storage under pressure is evicted whole, the outbox with it. Without the CORS header the file
  isn't kept: the page's own <script> load still works online. With no network and no copy of the
  core file, the page gets a line saying so in place of the browser's "Cannot load" alert.
- The status file, the tiddler list and the app's manifest: the network first, the cached one when
  the network fails, with X-Served-From: cache so the list sync knows (a device copy then counts
  whatever its revision). A page this worker answered from the cache for want of the network gets
  its first list from the cache at once, the fetch going on behind (the wait paid once: design 1.11).
- /favicon.ico: the browser asks for it at a navigation when the page has no icon link (TiddlyWiki
  sets its icon once started): answered here, empty, rather than by the worker.
- Anything else (a tiddler's contents, a save, a delete, the page published): the network only.
The page tells this worker its one setting at each load, the network wait
($:/config/cfworker/NetworkWait, the admin plugin's settings tab), which it keeps in its cache; asked,
it answers with it.
Whenever a page is cached, the files it refers to are kept with it (one missing is fetched) and the
plugin files it no longer refers to leave the cache. Once in place (the first visit registers it, the
page and the files already loaded past it), the worker takes the page, its files, the status file and
the tiddler list by itself, so one visit online is enough: two requests once per device, the page
(revalidated, 304) and the list; the status file from the browser's own cache.
\*/
(function() {

"use strict";

var CACHE = "cfworker-wiki-v1",
	MARK = "X-Wiki-Page",
	PAGE_MARK = "$:/cfworker/sw-url",   // in a wiki page's text: the public site's mark, where no header is ours
	PUBLIC = /[?&]site=public(?:&|$)/.test(self.location.search),   // the public site's copy (cold-start.js registers it so)
	FROM = "X-Served-From",
	PAGE_PATHS = ["/", "/index.html", "/baked.html"],
	DATA_PATHS = ["/status", "/recipes/default/tiddlers.json", "/manifest.webmanifest"],
	FILL_PATHS = ["/status", "/recipes/default/tiddlers.json"],   // taken with the page once this worker is in place
	LIST_PATH = "/recipes/default/tiddlers.json",
	PAGE_KEY = self.location.origin + "/",
	SETTINGS_KEY = self.location.origin + "/__cfworker/settings",   // this worker's settings, kept in its cache (no object of that name)
	NETWORK_WAIT = 8000,   // ms before the cached page answers instead of a network that doesn't ($:/config/cfworker/NetworkWait, told by the page)
	TIMED_OUT_FOR = 60000,   // ms a page answered from the cache after that wait is remembered, for its first list (design 1.11)
	NO_CORE = "No network, and no copy of TiddlyWiki's core file kept on this device: open the wiki once online first.";

// The settings the page tells this worker at each load (cold-start.js): it reads no tiddler itself.
// Kept in the cache, so a restarted worker has them before the page's next word.
var settings = {networkWait: NETWORK_WAIT},
	settingsLoaded = caches.open(CACHE).then(function(cache) {
		return cache.match(SETTINGS_KEY);
	}).then(function(kept) {
		return kept ? kept.json() : null;
	}).then(function(kept) {
		if(kept && kept.networkWait > 0) {
			settings.networkWait = kept.networkWait;
		}
	}).catch(function() {});

self.addEventListener("message",function(event) {
	var data = event.data || {};
	if(data.cfworker === "settings") {
		settingsLoaded.then(function() {
			if(data.networkWait > 0) {
				settings.networkWait = data.networkWait;
			}
			return caches.open(CACHE).then(function(cache) {
				return cache.put(SETTINGS_KEY,new Response(JSON.stringify(settings),{headers: {"Content-Type": "application/json"}}));
			});
		}).catch(function() {});
	} else if(data.cfworker === "ask" && event.source) {
		settingsLoaded.then(function() {
			event.source.postMessage({cfworker: "settings", networkWait: settings.networkWait});
		});
	}
});

self.addEventListener("install", function() {
	self.skipWaiting();
});

// Older caches of ours go; this version takes the open pages over at once, then fills its cache
self.addEventListener("activate", function(event) {
	event.waitUntil(caches.keys().then(function(names) {
		return Promise.all(names.filter(function(name) {
			return name.indexOf("cfworker-wiki-") === 0 && name !== CACHE;
		}).map(function(name) {
			return caches.delete(name);
		}));
	}).then(function() {
		return self.clients.claim();
	}).then(function() {
		return fill(event);
	}).catch(function() {}));
});

function isPage(request,url) {
	return url.origin === self.location.origin && (request.mode === "navigate" || PAGE_PATHS.indexOf(url.pathname) >= 0);
}
function isFile(url) {
	return /\/_plugins\/[^/]+\.js$/.test(url.pathname) && url.searchParams.has("v");
}
function isCore(url) {
	return /\/_plugins\/tiddlywikicore\.js$/.test(url.pathname);
}
function isData(url) {
	return url.origin === self.location.origin && DATA_PATHS.indexOf(url.pathname) >= 0;
}

// The pages answered from the cache because the network wait ran out (networkFirst's timer), by
// client id, with when: such a page's first list request is answered from the cache at once, the
// fetch going on behind to refresh it, so the wait isn't paid twice (design 1.11, 2.18). Keyed by the
// client, so another tab's poll keeps its wait; consumed by that one answer; forgotten after a minute,
// and with this worker's restart (a worker the browser stopped falls back to the wait)
var timedOut = {};
function noteTimedOut(clientId) {
	var now = Date.now();
	Object.keys(timedOut).forEach(function(id) {
		if(now - timedOut[id] > TIMED_OUT_FOR) {
			delete timedOut[id];
		}
	});
	if(clientId) {
		timedOut[clientId] = now;
	}
}
function pageTimedOut(clientId) {
	if(clientId && timedOut[clientId] && Date.now() - timedOut[clientId] <= TIMED_OUT_FOR) {
		delete timedOut[clientId];
		return true;
	}
	return false;
}

self.addEventListener("fetch",function(event) {
	var request = event.request;
	if(request.method !== "GET") {
		return;
	}
	var url = new URL(request.url);
	if(isPage(request,url)) {
		event.respondWith(PUBLIC ? staleWhileRevalidate(event,request) : networkFirst(event,request,PAGE_KEY,true));
	} else if(url.origin === self.location.origin && url.pathname === "/favicon.ico") {
		event.respondWith(new Response(null,{status: 204}));
	} else if(isFile(url)) {
		event.respondWith(cacheFirst(event,request));
	} else if(isData(url)) {
		// (Keyed by path: the list is asked for with a filter in the query, which the worker doesn't read)
		var key = url.origin + url.pathname;
		event.respondWith(url.pathname === LIST_PATH && pageTimedOut(event.clientId) ? cachedFirstOnce(event,request,key) : networkFirst(event,request,key,false));
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

// The public site's page: the kept page at once, the current one fetched behind it and kept for
// the next load, when it's a wiki page (storePage); without a kept page, the network first as on the
// admin site. A conditional fetch past the browser's copy, which a 304 from the site turns into the
// full page: a plain fetch within the page's Browser TTL would hand back the browser's copy and
// revalidate nothing. The kept page isn't noted as timed out: its first list goes to the network.
function staleWhileRevalidate(event,request) {
	return caches.open(CACHE).then(function(cache) {
		return cache.match(PAGE_KEY).then(function(hit) {
			if(!hit) {
				return networkFirst(event,request,PAGE_KEY,true);
			}
			event.waitUntil(fetch(request.url,{cache: "no-cache", credentials: "same-origin"}).then(function(response) {
				if(response && response.ok) {
					return storePage(cache,response,event);
				}
			}).catch(function() {}));
			return hit;
		});
	});
}

// The network, with the cached answer when it fails or takes too long; a good answer is kept (for
// the page, only a wiki page: storePage)
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
			if(response && response.ok) {
				var forCache = response.clone();
				event.waitUntil(caches.open(CACHE).then(function(cache) {
					return page ? storePage(cache,forCache,event) : cache.put(key,forCache);
				}).catch(function() {}));
			}
			return response;
		});
		event.waitUntil(fetching.catch(function() {}));
		settingsLoaded.then(function() {
			if(!done) {
				timer = setTimeout(function() {
					fromCache(key,page).then(function(hit) {
						if(hit) {
							if(page) {
								noteTimedOut(event.resultingClientId);
							}
							serve(hit);
						}
					});
				},settings.networkWait);
			}
		});
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

// The cached list at once, for a page the cache answered after the wait, the network's answer
// refreshing the cache behind; without a cached list, the network first as usual (design 1.11)
function cachedFirstOnce(event,request,key) {
	return fromCache(key,false).then(function(hit) {
		if(!hit) {
			return networkFirst(event,request,key,false);
		}
		event.waitUntil(fetch(request).then(function(response) {
			if(response && response.ok) {
				return caches.open(CACHE).then(function(cache) {
					return cache.put(key,response.clone());
				});
			}
		}).catch(function() {}));
		return hit;
	});
}

// The cache, else a fetch of the file, kept if it answered ok. If it can't be had that way (a site
// that doesn't allow CORS), the page's own plain request goes out instead, and nothing is kept; with
// no network either, the core file is answered with a line that says so, in place of the browser's
// "Cannot load" alert.
function cacheFirst(event,request) {
	var url = request.url;
	return caches.open(CACHE).then(function(cache) {
		return cache.match(url).then(function(hit) {
			if(hit) {
				return hit;
			}
			return fetchFile(cache,url,event).then(function(response) {
				if(response) {
					return response;
				}
				return fetch(request).catch(function(err) {
					if(isCore(new URL(url))) {
						return new Response("document.body.innerHTML=" + JSON.stringify("<p style=\"font:16px/1.5 sans-serif;max-width:36em;margin:3em auto;padding:0 1em\">" + NO_CORE + "</p>") + ";",
							{headers: {"Content-Type": "application/javascript; charset=utf-8"}});
					}
					throw err;
				});
			});
		});
	});
}

// A file fetched by its address alone and kept: not the page's own request, whose headers at a
// reload get a 304 the cache can't keep; through the browser's own cache for a file of this site (a
// fresh copy costs nothing); with CORS, past the browser's copy, for one from the public site (a copy
// taken before the site allowed CORS has no permission in it, and such a file is kept for a year).
// One fetch at a time per file, shared by whoever asks meanwhile, each given a copy of the answer
// (a body is read once: the one kept and each asker's are clones of one answer, which itself is
// never read); the copy is written under the first asker's event's waitUntil, so the browser
// doesn't stop this worker before it's done. Resolves with the copy, or null when the file can't
// be had that way.
var inFlight = Object.create(null);   // url -> promise of the answer, until the copy is written
function fetchFile(cache,url,event) {
	if(!inFlight[url]) {
		var sameSite = new URL(url).origin === self.location.origin,
			asked = sameSite ? fetch(url) : fetch(new Request(url,{mode: "cors", credentials: "omit", cache: "reload"}));
		inFlight[url] = asked.then(function(response) {
			if(response && response.ok) {
				event.waitUntil(cache.put(url,response.clone()).catch(function() {}).then(function() {
					delete inFlight[url];
				}));
				return response;
			}
			delete inFlight[url];
			return null;
		},function() {
			delete inFlight[url];
			return null;
		});
	}
	return inFlight[url].then(function(response) {
		return response ? response.clone() : null;
	});
}

// A page kept, when it's a wiki page, with the files it refers to: any other core or plugin file in
// the cache goes, one missing is fetched. A wiki page carries the worker's mark on the admin site,
// a header; on the public site, where the bucket adds none, the plugin's sw-url tiddler in its text,
// read before anything is written, so a 200 that isn't the wiki (an interstitial, a maintenance
// page) is never kept. Resolves with whether the page was kept.
function storePage(cache,response,event) {
	if(!PUBLIC && !response.headers.get(MARK)) {
		return Promise.resolve(false);
	}
	var forCache = response.clone();
	return response.text().then(function(html) {
		if(PUBLIC && (!/text\/html/i.test(response.headers.get("Content-Type") || "") || html.indexOf(PAGE_MARK) < 0)) {
			return false;
		}
		return cache.put(PAGE_KEY,forCache).then(function() {
			return keepFiles(cache,html,event);
		}).then(function() {
			return true;
		});
	});
}
function keepFiles(cache,html,event) {
	var keep = Object.create(null),
		pattern = /<script src="([^"]*\/_plugins\/[^"]*)"/g,
		found;
	while((found = pattern.exec(html)) !== null) {
		keep[new URL(found[1],PAGE_KEY).href] = true;
	}
	return cache.keys().then(function(requests) {
		return Promise.all(requests.filter(function(cached) {
			return isFile(new URL(cached.url)) && !keep[cached.url];
		}).map(function(cached) {
			return cache["delete"](cached);
		}));
	}).then(function() {
		return Promise.all(Object.keys(keep).map(function(url) {
			return cache.match(url).then(function(hit) {
				return hit ? null : fetchFile(cache,url,event);
			});
		}));
	});
}

// Once in place: the page (kept if it's a wiki page, storePage, with its files), the status file and
// the tiddler list, which the first visit loaded before this worker was there
function fill(event) {
	return caches.open(CACHE).then(function(cache) {
		var page = fetch(PAGE_KEY).then(function(response) {
			if(response.ok) {
				return storePage(cache,response,event);
			}
		});
		return Promise.all([page.catch(function() {})].concat(FILL_PATHS.map(function(path) {
			var key = self.location.origin + path;
			return fetch(key).then(function(response) {
				if(response.ok) {
					return cache.put(key,response);
				}
			}).catch(function() {});
		})));
	});
}

})();
