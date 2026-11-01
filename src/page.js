// Flipper: page script. Runs inside meet.google.com's own JavaScript world ("world": "MAIN").
//
// It flips only what is SENT to other participants. Your camera, Meet's own video pipeline and
// your self-view are never touched, so your preview always looks exactly as Meet shows it.
// The trick: Meet hands the video it wants to send to a peer connection (addTrack,
// addTransceiver, replaceTrack). We swap that track for a flipped copy right at that moment.
// Meet still sees its own track when it inspects the sender, so nothing on its side changes.
//
// This world can't use chrome.* APIs, so settings arrive from bridge.js via window.postMessage.
// The same channel carries the popup's live preview frames back out (see "Live preview" below).
(() => {
  'use strict';

  if (window.__flipperInstalled) return; // never wrap twice
  if (typeof RTCPeerConnection !== 'function' || typeof RTCRtpSender !== 'function') return;
  window.__flipperInstalled = true;

  const FROM_BRIDGE = 'flipper-content';
  const TO_BRIDGE = 'flipper-page';

  const cfg = { enabled: true, mode: 'horizontal' };
  let activeStreams = 0; // outgoing video tracks currently going through Flipper

  const send = (type, extra) =>
    window.postMessage({ source: TO_BRIDGE, type, ...extra }, window.location.origin);

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== FROM_BRIDGE) return;
    if (d.type === 'config') {
      cfg.enabled = d.enabled !== false;
      cfg.mode = ['horizontal', 'vertical', 'both'].includes(d.mode) ? d.mode : 'horizontal';
    } else if (d.type === 'ping') {
      send('status', { active: activeStreams });
    } else if (d.type === 'preview-watch') {
      watchPreview();
    } else if (d.type === 'preview-stop') {
      stopPreview();
    }
  });

  function flipAxes() {
    return {
      h: cfg.enabled && (cfg.mode === 'horizontal' || cfg.mode === 'both'),
      v: cfg.enabled && (cfg.mode === 'vertical' || cfg.mode === 'both'),
    };
  }

  // Draw one frame, mirrored according to the current settings.
  function drawFrame(ctx, src, w, h) {
    const { h: flipH, v: flipV } = flipAxes();
    ctx.save();
    ctx.translate(flipH ? w : 0, flipV ? h : 0);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(src, 0, 0, w, h);
    ctx.restore();
  }

  // Keeps Meet's track and our flipped copy in step, in both directions:
  //  - when Meet stops its track (camera off) or it ends (camera unplugged), the copy stops too,
  //    so nothing keeps running behind Meet's back;
  //  - when the copy ends on its own, we release whatever feeds it, and flippedCopy() builds a
  //    fresh one the next time Meet hands us that track.
  // A source can get a new copy over time, but its stop() and 'ended' hooks are installed only
  // once and always call the finish() of the copy currently linked to it.
  const wrappedSources = new WeakSet();
  const currentFinish = new WeakMap(); // source track -> finish() for the copy presently linked to it
  const livePairs = new Set(); // { source, copy } for every camera track currently going out through Flipper

  function linkLifecycle(copy, source, cleanup) {
    let finished = false;
    const pair = { source, copy };
    const finish = () => {
      if (finished) return;
      finished = true;
      livePairs.delete(pair);
      activeStreams = Math.max(0, activeStreams - 1);
      try {
        cleanup();
      } catch {
        /* nothing to clean up */
      }
      try {
        copy.stop();
      } catch {
        /* already stopped */
      }
      send('status', { active: activeStreams });
    };
    currentFinish.set(source, finish);
    if (!wrappedSources.has(source)) {
      wrappedSources.add(source);
      const nativeStop = source.stop.bind(source);
      source.stop = () => {
        nativeStop();
        currentFinish.get(source)?.();
      };
      source.addEventListener('ended', () => currentFinish.get(source)?.());
    }
    copy.addEventListener('ended', finish);
    livePairs.add(pair);
    activeStreams += 1;
    send('status', { active: activeStreams });
  }

  // Preferred path: insertable streams. Frames are processed directly, so it keeps working
  // when the Meet tab is in the background (canvas timers get throttled there).
  function flipWithInsertableStreams(source) {
    const canvas = new OffscreenCanvas(1280, 720);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D context'); // flippedCopy() then falls back to the canvas route

    const processor = new MediaStreamTrackProcessor({ track: source });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const teardown = new AbortController();
    let warned = false;

    // A flipped copy of one frame, or null when flipping is off or this frame can't be flipped.
    function flipFrame(frame) {
      const { h, v } = flipAxes();
      if (!h && !v) return null;
      try {
        const w = frame.displayWidth;
        const ht = frame.displayHeight;
        if (canvas.width !== w || canvas.height !== ht) {
          canvas.width = w;
          canvas.height = ht;
        }
        drawFrame(ctx, frame, w, ht);
        return new VideoFrame(canvas, { timestamp: frame.timestamp });
      } catch (err) {
        if (!warned) {
          warned = true; // one report is enough; this can repeat on every frame
          console.warn('[Flipper] could not flip a frame, sending it unflipped', err);
        }
        return null;
      }
    }

    // A failure here must never end the stream, or everyone in the call would see your video freeze.
    // So a frame that can't be flipped goes out exactly as Meet made it.
    const transformer = new TransformStream({
      transform(frame, controller) {
        const flipped = flipFrame(frame);
        if (flipped) frame.close(); // the flipped copy replaces it; otherwise the frame itself goes on
        controller.enqueue(flipped ?? frame);
      },
    });

    processor.readable
      .pipeThrough(transformer)
      .pipeTo(generator.writable, { signal: teardown.signal })
      .catch(() => {
        /* the pipeline ended: the track was stopped, or linkLifecycle() tore it down */
      });

    // Aborting the pipe also cancels the read from Meet's track, so a copy that ends on its own
    // doesn't leave frames being pulled and thrown away.
    linkLifecycle(generator, source, () => teardown.abort());
    return generator;
  }

  // Fallback: hidden <video> -> <canvas> -> captureStream. Can stall when the tab is hidden.
  function flipWithCanvas(source) {
    const s = source.getSettings();
    const fps = s.frameRate || 30;

    const canvas = document.createElement('canvas');
    canvas.width = s.width || 1280;
    canvas.height = s.height || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D context');
    // Everything that can throw comes before anything is started, so a failure leaves nothing running.
    const copy = canvas.captureStream(fps).getVideoTracks()[0];

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([source]);
    video.play().catch(() => {});

    const timer = setInterval(() => {
      if (video.readyState < 2) return;
      if (video.videoWidth && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      drawFrame(ctx, video, canvas.width, canvas.height);
    }, 1000 / fps);

    linkLifecycle(copy, source, () => {
      clearInterval(timer);
      video.srcObject = null;
    });
    return copy;
  }

  // Screen shares must never be flipped. Chrome marks them in the track's settings, and its
  // capture labels start with "screen:", "window:" or "web-contents-media-stream:".
  function isScreenShare(track) {
    let settings = {};
    try {
      settings = track.getSettings();
    } catch {
      /* unreadable settings: fall through to the label */
    }
    if (settings.displaySurface) return true;
    return /^(screen|window|web-contents-media-stream)\b/i.test(track.label || '');
  }

  const copies = new WeakMap(); // Meet's track -> the flipped copy that is actually sent
  const originals = new WeakMap(); // flipped copy -> Meet's track

  const shouldFlip = (track) =>
    track instanceof MediaStreamTrack &&
    track.kind === 'video' &&
    track.readyState === 'live' &&
    !originals.has(track) && // never flip our own copy again: two flips cancel each other out
    !isScreenShare(track);

  function flippedCopy(track) {
    let copy = copies.get(track);
    if (copy && copy.readyState === 'live') return copy;
    const canInsert =
      typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function';
    try {
      copy = canInsert ? flipWithInsertableStreams(track) : flipWithCanvas(track);
    } catch (err) {
      if (!canInsert) throw err;
      copy = flipWithCanvas(track); // insertable streams failed: try the canvas route
    }
    try {
      copy.contentHint = track.contentHint;
    } catch {
      /* not supported on this track */
    }
    copies.set(track, copy);
    originals.set(copy, track);
    console.info('[Flipper] flipping outgoing video track', track.label || track.id);
    return copy;
  }

  // What to actually send for a track Meet wants to send. Never breaks the call: if anything
  // goes wrong, the track goes out unflipped, exactly as Meet made it.
  function outgoing(track) {
    try {
      if (shouldFlip(track)) return flippedCopy(track);
    } catch (err) {
      console.warn('[Flipper] could not flip the outgoing video, sending it unflipped', err);
    }
    return track;
  }

  // ---- Live preview for the popup tiles ---------------------------------------------------
  // While the popup is open it shows two tiles: your camera (Meet's own track, which is what your
  // self-view shows) and what other people get. Meet's track is read out of a hidden <video> and
  // shrunk to a small picture; the second tile is that same small picture flipped by drawFrame(),
  // exactly as the outgoing video is. (Reading the outgoing copy back instead cost roughly 75 ms of
  // Meet's main thread per frame in testing: its frames live on the GPU and reading a full-size
  // one back stalls until the GPU answers.) Both go to bridge.js as small JPEGs, which hands them on
  // to the popup. Nothing here runs unless the popup keeps renewing its request.
  const PREVIEW_FPS = 10;
  const PREVIEW_WIDTH = 320; // widest frame sent to the popup, in px
  const PREVIEW_LEASE_MS = 5000; // stop on our own if the popup stops renewing its request

  let previewTimer = null;
  let previewLeaseEnd = 0;
  let previewSentFrame = false; // so 'preview-idle' is sent once when frames stop, not on every tick
  let previewWarned = false;
  let snapCanvas = null; // the small picture of your camera
  let snapCtx = null;
  let flipCanvas = null; // the same picture, flipped the way it is being sent
  let flipCtx = null;
  const previewVideos = new Map(); // track -> hidden <video> reading it, alive only while previewing

  function watchPreview() {
    previewLeaseEnd = Date.now() + PREVIEW_LEASE_MS;
    if (!previewTimer) previewTimer = setInterval(previewTick, 1000 / PREVIEW_FPS);
  }

  function stopPreview() {
    clearInterval(previewTimer);
    previewTimer = null;
    previewSentFrame = false;
    for (const video of previewVideos.values()) video.srcObject = null;
    previewVideos.clear();
  }

  function videoFor(track) {
    let video = previewVideos.get(track);
    if (!video) {
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([track]);
      video.play().catch(() => {});
      previewVideos.set(track, video);
    }
    return video;
  }

  // Two small JPEGs from what a <video> is showing right now, or null until its first frame arrives:
  // the picture as it is, and the same picture flipped by the current settings.
  function snapshots(video) {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const w = Math.round(video.videoWidth * Math.min(1, PREVIEW_WIDTH / video.videoWidth));
    const h = Math.round(video.videoHeight * (w / video.videoWidth));
    if (!snapCanvas) {
      // willReadFrequently keeps these canvases in CPU memory. Reading a GPU-backed canvas back with
      // toDataURL() measured about 17 ms per call, against under 1 ms this way.
      snapCanvas = document.createElement('canvas');
      flipCanvas = document.createElement('canvas');
      snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true });
      flipCtx = flipCanvas.getContext('2d', { willReadFrequently: true });
    }
    for (const canvas of [snapCanvas, flipCanvas]) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }
    snapCtx.drawImage(video, 0, 0, w, h);
    drawFrame(flipCtx, snapCanvas, w, h); // the very same flip the outgoing video gets
    return {
      self: snapCanvas.toDataURL('image/jpeg', 0.6),
      others: flipCanvas.toDataURL('image/jpeg', 0.6),
    };
  }

  function previewTick() {
    if (Date.now() > previewLeaseEnd) {
      stopPreview(); // the popup went away without saying so
      return;
    }
    try {
      let pair = null;
      for (const p of livePairs) pair = p; // the newest camera track
      for (const [track, video] of previewVideos) {
        if (pair && track === pair.source) continue;
        video.srcObject = null; // camera off or replaced: let go of the old track
        previewVideos.delete(track);
      }
      if (pair) {
        const frames = snapshots(videoFor(pair.source));
        if (frames) {
          previewSentFrame = true;
          send('preview-frame', frames);
          return;
        }
      }
      if (previewSentFrame) {
        previewSentFrame = false;
        send('preview-idle'); // the popup goes back to its placeholder straight away
      }
    } catch (err) {
      if (!previewWarned) {
        previewWarned = true; // this can repeat on every tick
        console.warn('[Flipper] popup preview failed', err);
      }
    }
  }

  const pcProto = RTCPeerConnection.prototype;
  const senderProto = RTCRtpSender.prototype;

  const nativeAddTrack = pcProto.addTrack;
  pcProto.addTrack = function addTrack(track, ...streams) {
    return nativeAddTrack.call(this, outgoing(track), ...streams);
  };

  const nativeAddTransceiver = pcProto.addTransceiver;
  pcProto.addTransceiver = function addTransceiver(trackOrKind, init) {
    return nativeAddTransceiver.call(this, outgoing(trackOrKind), init);
  };

  const nativeReplaceTrack = senderProto.replaceTrack;
  senderProto.replaceTrack = function replaceTrack(track) {
    return nativeReplaceTrack.call(this, outgoing(track));
  };

  // Meet finds its senders by comparing sender.track with its own track, so keep answering with
  // Meet's track, not our copy.
  const nativeTrack = Object.getOwnPropertyDescriptor(senderProto, 'track');
  if (nativeTrack && nativeTrack.get) {
    Object.defineProperty(senderProto, 'track', {
      ...nativeTrack,
      get() {
        const actual = nativeTrack.get.call(this);
        return (actual && originals.get(actual)) || actual;
      },
    });
  }

  send('hello');
  console.debug('[Flipper] page script ready');
})();