// Tunt lager mellan BLE-strängar och typade meddelanden. All kunskap om
// exakt textformat bor här — om firmware landar på ett annat format är det
// den här filen som ändras, inget annat.

import type { SessionPhase, Side } from './sessionMachine';

export type BoxMessage =
  | { type: 'hello'; boxId: string }
  | { type: 'boxid'; serverBoxId: string }
  | { type: 'ready_to_close' }
  | { type: 'net'; wifiUp: boolean; networkSaved: boolean; queued: number; ssid: string }
  | { type: 'state'; phase: SessionPhase; elapsedMs: number; seq: string }
  | { type: 'touch_begin'; side: Side }
  | { type: 'touch_end'; side: Side }
  | { type: 'checkin_complete' }
  | { type: 'phone_down' }
  | { type: 'lid_closed' }
  | { type: 'lid_opened' }
  | { type: 'session_started'; seq: string }
  | { type: 'session_ended'; seq: string; durationMs: number; completed: boolean; ageMs: number }
  | { type: 'battery'; percent: number };

const RESTORABLE_PHASES: SessionPhase[] = [
  'idle', 'checking_in', 'checked_in', 'awaiting_lid', 'active', 'respite',
];

function isRestorablePhase(value: string): value is SessionPhase {
  return (RESTORABLE_PHASES as string[]).includes(value);
}

function isSide(value: string): value is Side {
  return value === 'left' || value === 'right';
}

export function parseBoxMessage(raw: string): BoxMessage | null {
  const [head, ...rest] = raw.split(':');

  switch (head) {
    case 'hello': {
      const boxId = rest.join(':');
      return boxId ? { type: 'hello', boxId } : null;
    }
    // Lådans serverkända id (firmware v8.4+), t.ex. BOX001. Det är INTE
    // samma sak som `hello`, som bär chip-id:t. Utan det hamnar samma
    // fysiska låda i databasen under två olika id beroende på om det var
    // lådan eller appen som skrev raden.
    case 'boxid': {
      const serverBoxId = rest.join(':');
      return serverBoxId ? { type: 'boxid', serverBoxId } : null;
    }
    // En känd tagg ligger i lådan med locket öppet: pausen har inte börjat
    // än. Lådan startar den när locket stängs (firmware v8.5+).
    case 'ready_to_close':
      return { type: 'ready_to_close' };
    // Lådans nätverksläge (firmware v8.5+). Nätets namn ligger SIST och kan
    // innehålla kolon, så allt efter tredje fältet är namnet.
    case 'net': {
      const [upRaw, savedRaw, queuedRaw, ...ssidParts] = rest;
      const queued = Number(queuedRaw);
      if (upRaw === undefined || savedRaw === undefined || !Number.isFinite(queued)) return null;
      return {
        type: 'net',
        wifiUp: upRaw === '1',
        networkSaved: savedRaw === '1',
        queued,
        ssid: ssidParts.join(':'),
      };
    }
    case 'state': {
      const [phase, elapsedMsRaw, seq] = rest;
      if (!phase || !isRestorablePhase(phase) || !seq) return null;
      const elapsedMs = Number(elapsedMsRaw);
      if (!Number.isFinite(elapsedMs)) return null;
      return { type: 'state', phase, elapsedMs, seq };
    }
    case 'touch_begin':
    case 'touch_end': {
      const side = rest[0];
      if (!side || !isSide(side)) return null;
      return { type: head, side };
    }
    case 'checkin_complete':
      return { type: 'checkin_complete' };
    case 'phone_down':
      return { type: 'phone_down' };
    case 'lid_closed':
      return { type: 'lid_closed' };
    case 'lid_opened':
      return { type: 'lid_opened' };
    case 'session_started': {
      const seq = rest[0];
      if (!seq) return null;
      return { type: 'session_started', seq };
    }
    case 'session_ended': {
      const [seq, durationMsRaw, completedRaw, ageMsRaw] = rest;
      if (!seq) return null;
      const durationMs = Number(durationMsRaw);
      if (!Number.isFinite(durationMs)) return null;
      const ageMs = Number(ageMsRaw);
      return {
        type: 'session_ended',
        seq,
        durationMs,
        completed: completedRaw === '1',
        ageMs: Number.isFinite(ageMs) ? ageMs : 0,
      };
    }
    case 'battery': {
      const percent = Number(rest[0]);
      if (!Number.isFinite(percent)) return null;
      return { type: 'battery', percent };
    }
    default:
      return null;
  }
}

export function encodeSessionAck(seq: string): string {
  return `session_ack:${seq}`;
}

// Lådan parsar inte innehållet idag (bara flaggan att den mottagits), men
// formatet läggs på plats nu så det finns när lådan väl läser det.
export function encodeSetMode(mode: string, direction: 'UP' | 'DOWN', seconds: number): string {
  return `set_mode:${mode}:${direction}:${seconds}`;
}

export function encodePhoneDown(): string {
  return 'phone_down';
}

// Skickas när appen ser att telefonen lyfts upp under en pågående session.
// Lådan agerar bara på den när locket redan är öppet, men vi skickar den
// ändå bara medan vi vet att en session pågår (efter session_started, före
// session_ended) — se den globala lyft-detekteringen i app/_layout.tsx.
export function encodePhoneUp(): string {
  return 'phone_up';
}
