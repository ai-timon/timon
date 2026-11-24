'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { getLocale, t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import { apiErrorMessage } from '@/lib/api-error';
import {
  appendFragment, closeIdle, emptyTranscript, flushAll, isSpeaking, startRelay, takeDelegation,
  type Step, type VoiceSpeaker, type VoiceTranscript, type VoiceTurn,
} from './bridge';

export type GptLiveState = 'idle' | 'connecting' | 'live' | 'closing';

type LiveEvent = {
  type: string;
  delta?: unknown;
  start_ms?: unknown;
  end_ms?: unknown;
  delegation?: { id?: unknown; target?: unknown };
  error?: { message?: unknown; code?: unknown };
};

/** Past this, the session answer never came: better to say so than to hang. */
const ICE_TIMEOUT_MS = 10_000;
/** `session.close` drains pending work before `session.closed`; not forever. */
const CLOSE_TIMEOUT_MS = 15_000;
/** How often silent turns are checked for closing. */
const IDLE_TICK_MS = 300;

/** A chat message offered to GPT-Live as startup context. */
export type LiveHistoryMessage = { role: 'user' | 'assistant'; text: string };

export type LiveDelegation = {
  id: string;
  request: string;
  context: string;
  /** Turns folded into the request, whose live bubbles must go. */
  consumed: VoiceTurn[];
};

/** Turns on screen right now: the open ones and the held user turns. */
export type LiveTurns = { visible: VoiceTurn[]; speaking: boolean };

const NO_TURNS: LiveTurns = { visible: [], speaking: false };

function liveTurns(state: VoiceTranscript, now = Date.now()): LiveTurns {
  const open = [state.open.user, state.open.voice].filter((turn): turn is VoiceTurn => !!turn);
  return { visible: [...state.held, ...open], speaking: isSpeaking(state, now) };
}

function timeline(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function newTurnId(): string {
  return `v_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Why a voice session did not start. The settings cases keep this screen's
 * own sentences, which name where to fix them; any other code reads its
 * translated route error. The kebab-case codes are an older daemon's.
 */
export function sessionError(body: unknown, status: number): string {
  const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  if (code === 'gpt_live_disabled' || code === 'disabled') return t('gptLive.errorDisabled', { settingsPath: settingsPath('interface', 'voice') });
  if (code === 'gpt_live_no_key' || code === 'no-key') return t('gptLive.errorNoKey', { settingsPath: settingsPath('interface', 'voice') });
  if (code === 'gpt_live_bad_key' || code === 'bad-key') return t('gptLive.errorBadKey');
  if (code === 'gpt_live_rate_limited' || code === 'rate-limited') return t('gptLive.errorRateLimited');
  return t('gptLive.errorGeneric', { detail: apiErrorMessage(body, { status }) });
}

async function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', onState);
      reject(new Error('ICE gathering timed out'));
    }, ICE_TIMEOUT_MS);
    function onState(): void {
      if (peer.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', onState);
      resolve();
    }
    peer.addEventListener('icegatheringstatechange', onState);
  });
}

/**
 * A GPT-Live voice session over WebRTC, in client delegation.
 *
 * Audio goes browser ↔ OpenAI directly; the daemon only trades the SDP offer
 * (it holds the key). Both transcripts are grouped into turns (`bridge.ts`):
 * `turns` feeds the live bubbles, `onJournal` receives each
 * settled turn to write into the mission, and `onDelegation` the request
 * rebuilt when GPT-Live hands a turn over. `reply` returns the agent's answer
 * for GPT-Live to say; `inform` hands it an answer it never asked for. What
 * GPT-Live says next is that written answer read aloud: its turns are marked
 * `relay` until the user speaks again.
 */
export function useGptLive(opts: {
  onDelegation: (delegation: LiveDelegation) => void;
  onJournal: (turns: VoiceTurn[]) => void;
  /** Read once, when the session opens. */
  history?: () => LiveHistoryMessage[];
}): {
  state: GptLiveState;
  error: string;
  turns: LiveTurns;
  /** Microphone and GPT-Live's voice, for level meters; null when idle. */
  streams: { mic: MediaStream | null; remote: MediaStream | null };
  start: () => Promise<void>;
  stop: () => void;
  /** `written`: the text is the agent's answer, already in the thread. */
  reply: (delegationId: string, text: string, written: boolean) => void;
  inform: (text: string) => void;
} {
  const [state, setState] = useState<GptLiveState>('idle');
  const [error, setError] = useState('');
  const [turns, setTurns] = useState<LiveTurns>(NO_TURNS);
  const [streams, setStreams] = useState<{ mic: MediaStream | null; remote: MediaStream | null }>({ mic: null, remote: null });
  const peer = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const transcript = useRef<VoiceTranscript>(emptyTranscript());
  const idleTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalized = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSeq = useRef(0);
  const callbacks = useRef(opts);
  callbacks.current = opts;

  /** Applies a transition: new state, settled turns out, screen refreshed. */
  const apply = useCallback((step: Step) => {
    transcript.current = step.state;
    if (step.journal.length > 0) callbacks.current.onJournal(step.journal);
    setTurns(liveTurns(step.state));
  }, []);

  const cleanup = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    if (idleTimer.current) clearInterval(idleTimer.current);
    idleTimer.current = null;
    // Whatever was said and not yet settled still belongs to the conversation.
    const rest = flushAll(transcript.current);
    if (rest.journal.length > 0) callbacks.current.onJournal(rest.journal);
    mic.current?.getTracks().forEach((track) => track.stop());
    mic.current = null;
    channel.current?.close();
    channel.current = null;
    peer.current?.close();
    peer.current = null;
    if (audio.current) audio.current.srcObject = null;
    transcript.current = emptyTranscript();
    setTurns(NO_TURNS);
    setStreams({ mic: null, remote: null });
    setState('idle');
  }, []);

  const send = useCallback((event: Record<string, unknown>) => {
    const dc = channel.current;
    if (!dc || dc.readyState !== 'open') return;
    eventSeq.current += 1;
    dc.send(JSON.stringify({ event_id: `timon_${eventSeq.current}`, ...event }));
  }, []);

  const reply = useCallback((delegationId: string, text: string, written: boolean) => {
    send({ type: 'session.commentary.append', delegation_id: delegationId, content: text });
    if (written) apply(startRelay(transcript.current));
  }, [send, apply]);

  // A null delegation id is OpenAI's "general session context": GPT-Live
  // paraphrases commentary aloud whether or not it delegated anything.
  const inform = useCallback((text: string) => {
    send({ type: 'session.commentary.append', delegation_id: null, content: text });
    apply(startRelay(transcript.current));
  }, [send, apply]);

  const onMessage = useCallback((raw: string) => {
    let event: LiveEvent;
    try { event = JSON.parse(raw) as LiveEvent; } catch { return; }
    switch (event.type) {
      case 'session.started':
        setState('live');
        return;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        if (typeof event.delta !== 'string' || !event.delta) return;
        const speaker: VoiceSpeaker = event.type === 'session.input_transcript.delta' ? 'user' : 'voice';
        apply(appendFragment(
          transcript.current,
          speaker,
          { delta: event.delta, startMs: timeline(event.start_ms), endMs: timeline(event.end_ms) },
          Date.now(),
          newTurnId,
        ));
        return;
      }
      case 'session.delegation.created': {
        const id = event.delegation?.id;
        // Client mode is the only one this session opens, and OpenAI omits
        // `target` on some events: only an explicit other target is foreign.
        const target = event.delegation?.target;
        if (typeof id !== 'string' || (target !== undefined && target !== null && target !== 'client')) return;
        const delegation = takeDelegation(transcript.current);
        transcript.current = delegation.state;
        setTurns(liveTurns(delegation.state));
        if (delegation.request) {
          callbacks.current.onDelegation({ id, request: delegation.request, context: delegation.context, consumed: delegation.consumed });
        } else {
          // Nothing was heard: let GPT-Live ask again rather than post an empty turn.
          send({ type: 'session.thinking.append', delegation_id: id, content: 'No request was transcribed. Ask the user to repeat.' });
        }
        return;
      }
      case 'session.closed':
        finalized.current = true;
        cleanup();
        return;
      case 'error': {
        const message = typeof event.error?.message === 'string' ? event.error.message : 'unknown error';
        console.warn(`[gpt-live] ${message}`);
        return;
      }
      default:
    }
  }, [apply, cleanup, send]);

  const start = useCallback(async () => {
    if (peer.current) return;
    setError('');
    setState('connecting');
    finalized.current = false;
    try {
      const pc = new RTCPeerConnection();
      peer.current = pc;
      audio.current ??= new Audio();
      audio.current.autoplay = true;
      pc.addEventListener('track', (event) => {
        if (!audio.current) return;
        const remote = new MediaStream([event.track]);
        audio.current.srcObject = remote;
        setStreams((current) => ({ ...current, remote }));
        void audio.current.play().catch(() => { /* autoplay refused: the click that started us normally prevents it */ });
      });
      try {
        mic.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error(t('gptLive.errorMic'));
      }
      for (const track of mic.current.getAudioTracks()) pc.addTrack(track, mic.current);
      setStreams((current) => ({ ...current, mic: mic.current }));

      // The event channel must exist before the offer, or it is not negotiated.
      const dc = pc.createDataChannel('oai-events');
      channel.current = dc;
      dc.addEventListener('message', ({ data }) => { if (typeof data === 'string') onMessage(data); });
      dc.addEventListener('close', () => {
        if (channel.current !== dc || finalized.current) return;
        setError(t('gptLive.errorDropped'));
        cleanup();
      });

      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error(t('gptLive.errorGeneric', { detail: 'no SDP offer' }));

      const res = await fetch('/api/ui/gpt-live/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sdp,
          instructions: `The user's interface language is ${getLocale()}.`,
          history: callbacks.current.history?.() ?? [],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { sdp?: unknown; code?: unknown };
      if (!res.ok || typeof body.sdp !== 'string') throw new Error(sessionError(body, res.status));
      // A stop() during the exchange already tore the peer down.
      if (peer.current !== pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
      idleTimer.current = setInterval(() => {
        const now = Date.now();
        const step = closeIdle(transcript.current, now);
        if (step.state !== transcript.current) { apply(step); return; }
        // GPT-Live's turn stays open through its pauses: the sphere must still
        // stop "speaking" when the audio does.
        const speaking = isSpeaking(step.state, now);
        setTurns((current) => (current.speaking === speaking ? current : { ...current, speaking }));
      }, IDLE_TICK_MS);
    } catch (e) {
      setError((e as Error).message);
      cleanup();
    }
  }, [apply, cleanup, onMessage]);

  const stop = useCallback(() => {
    const dc = channel.current;
    if (!dc || dc.readyState !== 'open') { cleanup(); return; }
    setState('closing');
    // Keep media and events alive until `session.closed`: it carries the
    // final usage and lets pending speech drain.
    send({ type: 'session.close' });
    closeTimer.current = setTimeout(cleanup, CLOSE_TIMEOUT_MS);
  }, [cleanup, send]);

  // Leaving the chat must not leave a billed session running behind it.
  useEffect(() => () => {
    finalized.current = true;
    cleanup();
  }, [cleanup]);

  return { state, error, turns, streams, start, stop, reply, inform };
}
