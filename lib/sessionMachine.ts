// Ren tillståndsmaskin för en pausession. Inga React- eller BLE-beroenden.
//
// Den matas från ett enda ställe: app/pausing.tsx, det lådlösa flödet. Förr
// matade lådflödet samma reducer genom SessionContext, och faserna
// `checking_in`, `checked_in` och `awaiting_lid` var lådans ritual —
// tummarna, nedläggningen, locket. Sedan firmware v8.5 startar appen aldrig
// en lådpaus (lådan äger sina pauser hela vägen och laddar upp dem själv
// över WiFi), så de faserna, lockhändelserna och RESTORE är borta.
//
// En paus här är därför alltid telefonens egen: den börjar när skärmen
// läggs nedåt och fryser när den lyfts.

export type SessionPhase =
  | 'idle'
  | 'active'         // pausen räknar (uppåt, eller nedåt för 'regulate')
  | 'respite'        // telefonen lyftes eller vändes upp — tiden fryser
  | 'ended';         // klar, redo att visas i pausesummary

// 'sleep' är en natt (lib/sleep.ts): samma faser och samma frysning vid
// lyft, men den sparas som `kind = 'sleep'` och räknas aldrig som en paus.
export type PauseType = 'session' | 'regulate' | 'sleep';

export interface SessionEndedInfo {
  seq: string;
  durationMs: number;
  completed: boolean;
  /** Den lådlösa pausen visade sig vara en natt hela vägen (*Were you
   *  asleep?* i app/pausing.tsx): ingen sammanfattning, den slutar på Hem
   *  som en natt. */
  night?: boolean;
}

export interface SessionState {
  phase: SessionPhase;
  seq: string | null;
  pauseType: PauseType;
  targetSeconds?: number;      // bara relevant för 'regulate'
  category?: string;
  sharedSessionId?: string;
  sharedWithName?: string;
  /** epoch ms – ankare för hur mycket tid som har gått i aktuell fas */
  startedAt: number | null;
  /** epoch ms – när respiten började, så att elapsed kan frysas korrekt */
  respiteStartedAt: number | null;
  /** ackumulerad tid som ska dras bort från "nu - startedAt" (krasch-återställning) */
  elapsedBaselineMs: number;
  /** total tid tillbringad i respite hittills — dras av så att elapsed inte hoppar fram när pausen återupptas */
  pausedMs: number;
  lastEnded: SessionEndedInfo | null;
}

export const initialSessionState: SessionState = {
  phase: 'idle',
  seq: null,
  pauseType: 'session',
  targetSeconds: undefined,
  category: undefined,
  sharedSessionId: undefined,
  sharedWithName: undefined,
  startedAt: null,
  respiteStartedAt: null,
  elapsedBaselineMs: 0,
  pausedMs: 0,
  lastEnded: null,
};

export type SessionEvent =
  /** Telefonen är inte längre nedåtvänd — klockan fryser. */
  | { type: 'PHONE_LIFTED' }
  | { type: 'PHONE_RESTED' }
  | {
      type: 'SESSION_STARTED';
      seq: string;
      pauseType?: PauseType;
      targetSeconds?: number;
      category?: string;
      sharedSessionId?: string;
      sharedWithName?: string;
    }
  | { type: 'SESSION_ENDED'; seq: string; durationMs: number; completed: boolean; night?: boolean }
  | { type: 'RESET' };

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'PHONE_LIFTED':
      if (state.phase !== 'active') return state;
      return { ...state, phase: 'respite', respiteStartedAt: Date.now() };

    case 'PHONE_RESTED': {
      if (state.phase !== 'respite') return state;
      const justPausedMs = state.respiteStartedAt ? Date.now() - state.respiteStartedAt : 0;
      return {
        ...state,
        phase: 'active',
        respiteStartedAt: null,
        pausedMs: state.pausedMs + justPausedMs,
      };
    }

    case 'SESSION_STARTED':
      return {
        ...state,
        phase: 'active',
        seq: event.seq,
        pauseType: event.pauseType ?? state.pauseType,
        targetSeconds: event.targetSeconds ?? state.targetSeconds,
        category: event.category ?? state.category,
        sharedSessionId: event.sharedSessionId ?? state.sharedSessionId,
        sharedWithName: event.sharedWithName ?? state.sharedWithName,
        startedAt: Date.now(),
        elapsedBaselineMs: 0,
        pausedMs: 0,
        respiteStartedAt: null,
        lastEnded: null,
      };

    case 'SESSION_ENDED':
      // En sen eller duplicerad SESSION_ENDED för en annan seq än den vi tror
      // pågår ignoreras för fasövergången.
      if (state.seq !== null && state.seq !== event.seq) {
        return state;
      }
      return {
        ...state,
        phase: 'ended',
        lastEnded: { seq: event.seq, durationMs: event.durationMs, completed: event.completed, night: event.night },
      };

    case 'RESET':
      return initialSessionState;

    default:
      return state;
  }
}
