/**
 * SM GPT Backend API & SSE Streaming Client
 * Communicates solely with the SM GPT backend endpoints; never loads or executes models in browser.
 */

/**
 * Parses a raw SSE chunk buffer into complete `{ event, data }` frames plus remaining unparsed tail.
 *
 * @param {string} buffer
 * @returns {{ events: Array<{ event: string, data: any }>, rest: string }}
 */
export function parseSseBuffer(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  const rest = frames.pop() ?? '';
  const events = [];

  for (const frame of frames) {
    if (!frame.trim()) continue;
    let eventName = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join('\n');
    let parsed = rawData;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      // Keep raw string if payload isn't JSON
    }
    events.push({ event: eventName, data: parsed });
  }

  return { events, rest };
}

export async function fetchBackendStatus(signal) {
  const res = await fetch('/api/model/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) {
    throw new Error(`Status check failed (${res.status})`);
  }
  return res.json();
}

export async function stopBackendGeneration({ requestId, conversationId }) {
  try {
    const res = await fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, conversationId }),
    });
    if (!res.ok) return { stopped: false };
    return res.json();
  } catch {
    return { stopped: false };
  }
}

/**
 * Streams a chat completion over POST /api/chat/stream (Server-Sent Events).
 */
export async function streamBackendChat(
  { conversationId, requestId, messages, options },
  { signal, onStart, onToken, onComplete, onCancelled, onError }
) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ conversationId, requestId, messages, options }),
    signal,
  });

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
    let errorMessage = 'Unable to reach SM GPT backend.';
    let errorCode = 'REQUEST_FAILED';
    try {
      const payload = await res.json();
      if (payload?.error?.message) errorMessage = payload.error.message;
      if (payload?.error?.code) errorCode = payload.error.code;
    } catch {
      // Fallback to generic error
    }
    onError?.({ requestId, code: errorCode, message: errorMessage, recoverable: true });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let terminalEventSeen = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;

      for (const evt of events) {
        if (evt.event === 'start') {
          onStart?.(evt.data);
        } else if (evt.event === 'token') {
          onToken?.(evt.data);
        } else if (evt.event === 'complete') {
          terminalEventSeen = true;
          onComplete?.(evt.data);
        } else if (evt.event === 'cancelled') {
          terminalEventSeen = true;
          onCancelled?.(evt.data);
        } else if (evt.event === 'error') {
          terminalEventSeen = true;
          onError?.(evt.data);
        }
      }
    }

    if (buffer.trim()) {
      const { events } = parseSseBuffer(`${buffer}\n\n`);
      for (const evt of events) {
        if (evt.event === 'complete') {
          terminalEventSeen = true;
          onComplete?.(evt.data);
        } else if (evt.event === 'cancelled') {
          terminalEventSeen = true;
          onCancelled?.(evt.data);
        } else if (evt.event === 'error') {
          terminalEventSeen = true;
          onError?.(evt.data);
        }
      }
    }

    if (!terminalEventSeen && !signal?.aborted) {
      onError?.({
        requestId,
        code: 'STREAM_ENDED_UNEXPECTEDLY',
        message: 'Connection to SM GPT backend ended before completion.',
        recoverable: true,
      });
    }
  } catch (err) {
    if (signal?.aborted) {
      return;
    }
    onError?.({
      requestId,
      code: 'STREAM_READ_ERROR',
      message: err instanceof Error ? err.message : 'Lost connection while streaming response.',
      recoverable: true,
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release error
    }
  }
}
