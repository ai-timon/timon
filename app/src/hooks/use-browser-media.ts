'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { base64ToBytes } from '@/lib/native-browser-input';
import type { BrowserCommand } from '@/lib/native-browser';
import { encodedMimeTypes } from '@/lib/browser-media-formats';

export type BrowserMediaState = { phase: 'idle' | 'connecting' | 'live' | 'error'; transport: 'webrtc' | 'https' | null; error: string | null; stats: string; autoplayBlocked: boolean };
const initial: BrowserMediaState = { phase: 'idle', transport: null, error: null, stats: '', autoplayBlocked: false };

function eventUntil(target: EventTarget, event: string, ready: () => boolean, signal: AbortSignal, timeout: number): Promise<void> {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); target.removeEventListener(event, check); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
    const check = () => { if (ready()) finish(); };
    const cancel = () => finish(new DOMException('Media closed', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Video connection timed out')), timeout);
    target.addEventListener(event, check); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** A remote profile remains the same across WebRTC/HTTPS transport negotiation. */
export function useBrowserMedia(videoRef: RefObject<HTMLVideoElement | null>, enabled: boolean, profileId: string | null, tabId: string | null, audio: boolean, command: BrowserCommand, revision: number | string) {
  const [state, setState] = useState<BrowserMediaState>(initial);
  const closedSession = useRef(Promise.resolve());
  useEffect(() => {
    const element = videoRef.current;
    if (!enabled || !profileId || !tabId || !element) { setState(initial); return; }
    const video = element;
    const abort = new AbortController();
    let peer: RTCPeerConnection | null = null;
    let mediaId: string | null = null;
    let objectUrl: string | null = null;
    let renew: ReturnType<typeof setInterval> | null = null;
    let statsTimer: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let offerPending: Promise<{ answer: RTCSessionDescriptionInit; mediaId: string }> | null = null;
    let startPending: Promise<{ mediaId: string; mimeType: string }> | null = null;
    let mse: MediaSource | null = null;
    let fallbackStarted = false;
    const patch = (value: Partial<BrowserMediaState>) => { if (!abort.signal.aborted) setState((old) => ({ ...old, ...value })); };
    const stopSession = () => {
      const id = mediaId; mediaId = null;
      if (renew) { clearInterval(renew); renew = null; }
      if (id) closedSession.current = closedSession.current.then(async () => { await command('mediaStop', { mediaId: id }).catch(() => {}); });
      return closedSession.current;
    };
    const renewSession = (id: string) => {
      if (abort.signal.aborted) { void command('mediaStop', { mediaId: id }).catch(() => {}); return; }
      mediaId = id;
      if (renew) clearInterval(renew);
      renew = setInterval(() => { void command('mediaRenew', { mediaId: id }).catch((err) => {
        if (watchdog) { clearInterval(watchdog); watchdog = null; }
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        peer?.close(); void stopSession(); patch({ phase: 'error', error: (err as Error).message });
      }); }, 20_000);
    };
    const play = () => { const attempt = video.play(); void attempt?.catch(() => patch({ autoplayBlocked: true })); };
    video.muted = !audio;
    patch({ phase: 'connecting', error: null, stats: '', transport: null, autoplayBlocked: false });

    async function encoded() {
      if (fallbackStarted || abort.signal.aborted) return;
      fallbackStarted = true;
      peer?.close(); peer = null;
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
      const pending = offerPending;
      if (pending) { const offered = await pending.catch(() => null); if (offered && mediaId !== offered.mediaId) await command('mediaStop', { mediaId: offered.mediaId }).catch(() => {}); }
      await stopSession();
      if (abort.signal.aborted) return;
      if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
      patch({ phase: 'connecting', transport: 'https', stats: '' });
      try {
        const MediaSourceConstructor = globalThis.MediaSource ?? (globalThis as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
        if (!MediaSourceConstructor) throw new Error('This browser does not support live video playback.');
        const supportedMimeTypes = encodedMimeTypes(audio, (type) => MediaSourceConstructor.isTypeSupported(type));
        if (!supportedMimeTypes.length) throw new Error('This browser does not support the available live video formats.');
        startPending = command<{ mediaId: string; mimeType: string }>('mediaStart', { audio, supportedMimeTypes });
        const result = await startPending; startPending = null;
        renewSession(result.mediaId);
        if (abort.signal.aborted) return;
        if (!MediaSourceConstructor.isTypeSupported(result.mimeType)) throw new Error(`Unsupported video format: ${result.mimeType}`);
        mse = new MediaSourceConstructor();
        video.srcObject = null;
        objectUrl = URL.createObjectURL(mse); video.src = objectUrl;
        await eventUntil(mse, 'sourceopen', () => mse?.readyState === 'open', abort.signal, 8000);
        if (abort.signal.aborted) return;
        const buffer = mse.addSourceBuffer(result.mimeType);
        let sequence = -1;
        let bytes = 0;
        let statsAt = Date.now();
        const updateBuffer = (operation: () => void) => new Promise<void>((resolve, reject) => {
          const cleanup = () => { buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', failed); abort.signal.removeEventListener('abort', cancelled); };
          const done = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(new Error('Video decoder rejected a segment')); };
          const cancelled = () => { cleanup(); reject(new DOMException('Media closed', 'AbortError')); };
          buffer.addEventListener('updateend', done, { once: true }); buffer.addEventListener('error', failed, { once: true }); abort.signal.addEventListener('abort', cancelled, { once: true });
          try { operation(); } catch (err) { cleanup(); reject(err); }
        });
        while (!abort.signal.aborted) {
          const chunk = await command<{ data: string; sequence: number; eof: boolean }>('mediaRead', { mediaId: result.mediaId });
          if (abort.signal.aborted) break;
          if (chunk.eof) throw new Error('Video stream ended.');
          if (!chunk.data) continue;
          if (chunk.sequence !== sequence + 1) throw new Error('Video stream lost a segment. Reconnect to continue.');
          sequence = chunk.sequence;
          const data = base64ToBytes(chunk.data); bytes += data.byteLength;
          if (buffer.buffered.length && video.currentTime > 15) {
            const from = buffer.buffered.start(0); const until = Math.max(0, video.currentTime - 10);
            if (until > from) await updateBuffer(() => buffer.remove(from, until));
          }
          await updateBuffer(() => buffer.appendBuffer(data));
          if (buffer.buffered.length) {
            const end = buffer.buffered.end(buffer.buffered.length - 1);
            if (end - video.currentTime > 2) video.currentTime = Math.max(buffer.buffered.start(0), end - .4);
            patch({ phase: 'live', error: null }); play();
            if (Date.now() - statsAt >= 1000) { patch({ stats: `${Math.round(bytes * 8 / (Date.now() - statsAt))} kb/s · ${Math.max(0, end - video.currentTime).toFixed(1)} s` }); statsAt = Date.now(); bytes = 0; }
          }
        }
      } catch (err) { if (!abort.signal.aborted) { await stopSession(); patch({ phase: 'error', error: (err as Error).message }); } }
    }

    async function rtc() {
      try {
        await closedSession.current;
        if (abort.signal.aborted) return;
        if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC unavailable');
        peer = new RTCPeerConnection({ iceServers: [] });
        const activePeer = peer;
        const stream = new MediaStream();
        peer.addTransceiver('video', { direction: 'recvonly' });
        if (audio) peer.addTransceiver('audio', { direction: 'recvonly' });
        peer.ontrack = (event) => { stream.addTrack(event.track); if (!abort.signal.aborted) { video.srcObject = stream; play(); } };
        peer.onconnectionstatechange = () => { if (activePeer.connectionState === 'failed') void encoded(); };
        await peer.setLocalDescription(await peer.createOffer());
        await eventUntil(peer, 'icegatheringstatechange', () => activePeer.iceGatheringState === 'complete', abort.signal, 4000);
        if (abort.signal.aborted) return;
        offerPending = command<{ answer: RTCSessionDescriptionInit; mediaId: string }>('mediaOffer', { offer: peer.localDescription?.toJSON(), audio });
        const result = await offerPending;
        offerPending = null;
        if (abort.signal.aborted || fallbackStarted) { await command('mediaStop', { mediaId: result.mediaId }).catch(() => {}); return; }
        renewSession(result.mediaId);
        await peer.setRemoteDescription(result.answer);
        await eventUntil(peer, 'connectionstatechange', () => activePeer.connectionState === 'connected', abort.signal, 8000);
        if (abort.signal.aborted || fallbackStarted) return;
        patch({ phase: 'live', transport: 'webrtc', error: null });
        const connectedAt = Date.now();
        let disconnectedAt = 0;
        let decoded = false;
        watchdog = setInterval(() => {
          if (video.videoWidth > 0 && video.readyState >= 2) decoded = true;
          if (activePeer.connectionState === 'disconnected') disconnectedAt ||= Date.now(); else disconnectedAt = 0;
          if ((!decoded && Date.now() - connectedAt > 10_000) || (disconnectedAt && Date.now() - disconnectedAt > 5000)) void encoded();
        }, 1000);
        let previous = { at: performance.now(), bytes: 0 };
        statsTimer = setInterval(() => {
          void activePeer.getStats().then((report) => {
            report.forEach((row) => { if (row.type === 'inbound-rtp' && (row.kind === 'video' || row.mediaType === 'video')) {
              const at = performance.now(); const rate = Math.max(0, Math.round((Number(row.bytesReceived) - previous.bytes) * 8 / Math.max(1, at - previous.at)));
              previous = { at, bytes: Number(row.bytesReceived) }; patch({ stats: `${Math.round(Number(row.framesPerSecond ?? 0))} fps · ${rate} kb/s` });
            } });
          }).catch(() => {});
        }, 2000);
      } catch { if (!abort.signal.aborted) await encoded(); }
    }
    void rtc();
    return () => {
      abort.abort();
      if (renew) clearInterval(renew); if (statsTimer) clearInterval(statsTimer); if (watchdog) clearInterval(watchdog);
      peer?.close(); void stopSession();
      const pending = offerPending ?? startPending;
      if (pending) closedSession.current = closedSession.current.then(async () => {
        const result = await pending.catch(() => null);
        if (result) await command('mediaStop', { mediaId: result.mediaId }).catch(() => {});
      });
      video.srcObject = null; video.removeAttribute('src');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, profileId, tabId, audio, command, revision, videoRef]);
  return { ...state, resume: () => {
    void videoRef.current?.play().then(() => setState((old) => ({ ...old, autoplayBlocked: false }))).catch((err) => setState((old) => ({ ...old, autoplayBlocked: true, error: (err as Error).message })));
  } };
}
