(function (root) {
  "use strict";

  var SyanPlayer = {};
  var HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";
  var hlsLoaded = false;

  function loadHls(cb) {
    if (hlsLoaded || root.Hls) { hlsLoaded = true; cb(); return; }
    var s = document.createElement("script");
    s.src = HLS_CDN;
    s.onload = function () { hlsLoaded = true; cb(); };
    s.onerror = function () { cb(new Error("Failed to load HLS.js")); };
    document.head.appendChild(s);
  }

  function mount(opts) {
    if (!opts) throw new Error("SyanPlayer.mount: options required");
    var el = typeof opts.element === "string" ? document.querySelector(opts.element) : opts.element;
    if (!el) throw new Error("SyanPlayer.mount: element not found");
    if (!opts.publicId) throw new Error("SyanPlayer.mount: publicId required");

    var cmsBase = opts.cmsBase || "";
    var publicId = opts.publicId;
    var launchToken = opts.launchToken || null;
    var embedToken = opts.embedToken || null;
    var sessionId = null;
    var hls = null;
    var video = null;
    var destroyed = false;
    var pingInterval = null;
    var refreshTimeout = null;
    var expiresIn = 300;
    var callbacks = {
      onReady: opts.onReady || null,
      onPlay: opts.onPlay || null,
      onPause: opts.onPause || null,
      onTimeUpdate: opts.onTimeUpdate || null,
      onSeek: opts.onSeek || null,
      onEnded: opts.onEnded || null,
      onComplete: opts.onComplete || null,
      onError: opts.onError || null,
      onViolation: opts.onViolation || null,
      onSessionExpired: opts.onSessionExpired || null,
    };

    video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.backgroundColor = "#000";
    if (opts.controls !== false) video.controls = true;
    if (opts.muted) video.muted = true;
    if (opts.poster) video.poster = opts.poster;
    el.appendChild(video);

    function fire(name, data) {
      var fn = callbacks[name];
      if (fn) try { fn(data); } catch (e) { console.error("SyanPlayer callback error:", e); }
    }

    function sendEvent(type, time, payload) {
      if (!sessionId) return;
      fetch(cmsBase + "/api/integrations/player/" + publicId + "/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationSessionId: sessionId,
          events: [{ type: type, time: time || 0, payload: payload || {} }],
        }),
      }).catch(function () {});
    }

    function sendPing() {
      if (!sessionId || destroyed) return;
      fetch(cmsBase + "/api/integrations/player/" + publicId + "/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationSessionId: sessionId,
          currentTime: video.currentTime || 0,
          duration: video.duration || 0,
          paused: video.paused,
          ended: video.ended,
          playbackRate: video.playbackRate,
        }),
      }).catch(function () {});
    }

    function scheduleRefresh() {
      if (refreshTimeout) clearTimeout(refreshTimeout);
      var refreshMs = Math.max((expiresIn - 30) * 1000, 10000);
      refreshTimeout = setTimeout(doRefresh, refreshMs);
    }

    function doRefresh() {
      if (!sessionId || !embedToken || destroyed) return;
      fetch(cmsBase + "/api/integrations/player/" + publicId + "/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integrationSessionId: sessionId, embedToken: embedToken }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            embedToken = data.embedToken;
            expiresIn = data.expiresIn || 300;
            scheduleRefresh();
          } else {
            fire("onSessionExpired", data.error);
          }
        })
        .catch(function (e) {
          fire("onError", { code: "REFRESH_FAILED", message: e.message });
        });
    }

    function attachEvents() {
      video.addEventListener("play", function () { fire("onPlay"); sendEvent("play", video.currentTime); });
      video.addEventListener("pause", function () { fire("onPause"); sendEvent("pause", video.currentTime); });
      video.addEventListener("ended", function () { fire("onEnded"); sendEvent("ended", video.currentTime); sendPing(); });
      video.addEventListener("timeupdate", function () { fire("onTimeUpdate", { currentTime: video.currentTime, duration: video.duration }); });
      video.addEventListener("seeked", function () { fire("onSeek", { currentTime: video.currentTime }); sendEvent("seek", video.currentTime); });
    }

    function startPlayback(manifestUrl) {
      loadHls(function (err) {
        if (err) { fire("onError", { code: "HLS_LOAD_FAILED", message: err.message }); return; }
        if (destroyed) return;

        if (root.Hls && root.Hls.isSupported()) {
          hls = new root.Hls({ startPosition: opts.startAt || 0 });
          hls.loadSource(manifestUrl);
          hls.attachMedia(video);
          hls.on(root.Hls.Events.MANIFEST_PARSED, function () {
            fire("onReady");
            if (opts.autoplay) video.play().catch(function () {});
          });
          hls.on(root.Hls.Events.ERROR, function (ev, data) {
            if (data.fatal) fire("onError", { code: "HLS_ERROR", message: data.type + "/" + data.details });
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = manifestUrl;
          video.addEventListener("loadedmetadata", function () {
            fire("onReady");
            if (opts.startAt) video.currentTime = opts.startAt;
            if (opts.autoplay) video.play().catch(function () {});
          });
        } else {
          fire("onError", { code: "HLS_NOT_SUPPORTED", message: "HLS is not supported in this browser" });
        }

        attachEvents();
        pingInterval = setInterval(sendPing, 10000);
        scheduleRefresh();
      });
    }

    async function init() {
      try {
        if (launchToken && !embedToken) {
          var res = await fetch(cmsBase + "/api/integrations/player/" + publicId + "/mint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ launchToken: launchToken }),
          });
          var data = await res.json();
          if (!data.ok) { fire("onError", data.error || { code: "MINT_FAILED" }); return; }
          embedToken = data.embedToken;
          sessionId = data.integrationSessionId;
          expiresIn = data.expiresIn || 300;
          startPlayback(data.manifestUrl);
        } else if (embedToken) {
          sessionId = "embed-direct-" + Date.now();
          var manifestUrl = cmsBase + "/api/player/" + publicId + "/manifest?token=" + embedToken;
          startPlayback(manifestUrl);
        } else {
          fire("onError", { code: "NO_TOKEN", message: "Provide launchToken or embedToken" });
        }
      } catch (e) {
        fire("onError", { code: "INIT_FAILED", message: e.message });
      }
    }

    init();

    return {
      play: function () { video && video.play(); },
      pause: function () { video && video.pause(); },
      seek: function (s) { if (video) video.currentTime = s; },
      setPlaybackRate: function (r) { if (video) video.playbackRate = r; },
      enterFullscreen: function () {
        if (video.requestFullscreen) video.requestFullscreen();
        else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      },
      exitFullscreen: function () { if (document.exitFullscreen) document.exitFullscreen(); },
      getCurrentTime: function () { return video ? video.currentTime : 0; },
      getDuration: function () { return video ? video.duration : 0; },
      getState: function () {
        return {
          currentTime: video ? video.currentTime : 0,
          duration: video ? video.duration : 0,
          paused: video ? video.paused : true,
          ended: video ? video.ended : false,
          sessionId: sessionId,
        };
      },
      destroy: function () {
        destroyed = true;
        if (pingInterval) clearInterval(pingInterval);
        if (refreshTimeout) clearTimeout(refreshTimeout);
        if (hls) { hls.destroy(); hls = null; }
        if (video) { video.pause(); video.src = ""; video.remove(); video = null; }
      },
    };
  }

  SyanPlayer.mount = mount;
  root.SyanPlayer = SyanPlayer;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SyanPlayer;
  }
})(typeof window !== "undefined" ? window : this);
