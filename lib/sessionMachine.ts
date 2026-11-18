// Ren tillståndsmaskin för en pausession. Inga React- eller BLE-beroenden.
// Både lådflödet och det lådlösa flödet matar samma reducer — skillnaden är
// bara vem som producerar händelserna (BLEContext vs en manuell trigger).

export type SessionPhase =
  | 'idle'
  | 'checking_in'   // väntar på att båda tummarna ska hållas i 1,5s
  | 'checked_in'    // klart, väntar på att telefonen läggs ner
  | 'awaiting_lid'   // telefonen ligger ner, väntar på att locket stängs
  | 'active'        // pausen räknar (uppåt för låda, upp eller ner utan låda)
  | 'respite'        // locket öppnades mitt i en aktiv paus — tiden fryser
  | 'ended';         // klar, redo att visas i pausesummary

export type Side = 'left' | 'right';

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
  withPod: boolean;
  seq: string | null;
  pauseType: PauseType;
  targetSeconds?: number;      // bara relevant för lådlös 'regulate'
  category?: string;
  sharedSessionId?: string;
  sharedWithName?: string;
  /** epoch ms – ankare för hur mycket tid som har gått i aktuell fas */
  startedAt: number | null;
  /** epoch ms – när respiten började, så att elapsed kan frysas korrekt */
  respiteStartedAt: number | null;
  /** ackumulerad tid som ska dras bort från "nu - startedAt" (t.ex. vid RESTORE) */
  elapsedBaselineMs: number;
  /** total tid tillbringad i respite hittills — dras av så att elapsed hoppar inte fram när pausen återupptas */
  pausedMs: number;
  lastEnded: SessionEndedInfo | null;
}

export const initialSessionState: SessionState = {
  phase: 'idle',
  withPod: false,
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
  | { type: 'ENTER_CHECKIN'; category?: string; sharedSessionId?: string }
  | { type: 'CHECKIN_COMPLETE' }
  | { type: 'PHONE_DOWN' }
  | { type: 'LID_CLOSED' }
  | { type: 'LID_OPENED' }
  /** Lådlöst: telefonen är inte längre nedåtvänd — klockan fryser. Locket är
   *  lådans vila, skärmen nedåt är den lådlösa motsvarigheten, så båda landar
   *  i samma 'respite'-fas och samma pausedMs-bokföring. */
  | { type: 'PHONE_LIFTED' }
  | { type: 'PHONE_RESTED' }
  | {
      // För lådflödet skickar box_message bara `seq` — kategori/delad-session
      // sattes redan av ENTER_CHECKIN och behålls. Det lådlösa flödet anger
      // allt explicit eftersom det inte går via ENTER_CHECKIN.
      type: 'SESSION_STARTED';
      seq: string;
      withPod: boolean;
      pauseType?: PauseType;
      targetSeconds?: number;
      category?: string;
      sharedSessionId?: string;
      sharedWithName?: string;
    }
  | { type: 'SESSION_ENDED'; seq: string; durationMs: number; completed: boolean; night?: boolean }
  /** Box skickar sitt aktuella tillstånd direkt efter anslutning — hoppar rakt in, förbi normala övergångar. */
  | { type: 'RESTORE'; phase: SessionPhase; elapsedMs: number; seq: string; withPod: boolean }
  | { type: 'RESET' };

export function sessionReducer(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case 'ENTER_CHECKIN':
      // Namnet är kvar av historiska skäl — i v6 börjar ritualen med att
      // vänta på att telefonen ställs i lådan, inte med tumincheckningen.
      if (state.phase !== 'idle') return state;
      return {
        ...initialSessionState,
        phase: 'awaiting_lid',
        withPod: true,
        category: event.category,
        sharedSessionId: event.sharedSessionId,
      };

    case 'CHECKIN_COMPLETE':
      if (state.phase !== 'checking_in') return state;
      return { ...state, phase: 'checked_in' };

    case 'PHONE_DOWN':
      if (state.phase !== 'checked_in') return state;
      return { ...state, phase: 'awaiting_lid' };

    case 'LID_CLOSED':
      // Informationsbärande i awaiting_lid/respite — den auktoritativa övergången
      // till 'active' sker på SESSION_STARTED, inte här. I respite tar vi oss
      // ändå tillbaka till 'active' direkt eftersom lådan redan räknat vidare.
      // withPod-kontrollen skyddar en lådlös session mot en låda som råkar
      // vara ansluten samtidigt och skickar egna lock-händelser.
      if (state.phase === 'respite' && state.withPod) {
        const justPausedMs = state.respiteStartedAt ? Date.now() - state.respiteStartedAt : 0;
        return {
          ...state,
          phase: 'active',
          respiteStartedAt: null,
          pausedMs: state.pausedMs + justPausedMs,
        };
      }
      // Locket stängs efter att telefonen lagts ner — nu väntar lådan på tummarna.
      if (state.phase === 'awaiting_lid' && state.withPod) {
        return { ...state, phase: 'checking_in' };
      }
      return state;

    case 'LID_OPENED':
      // 'checked_in' räknas med: lådans sessionRunning() omfattar CHECKED_IN
      // (startceremonin, ~8,4 s med klockan igång), så ett lock som öppnas
      // där sätter lådan i RESPITE. Speglade appen inte det blev faserna
      // permanent osynkade — appen stod kvar i 'checked_in' och förstod
      // sedan varken lock- eller lyft-händelser.
      if (!state.withPod) return state;
      // Locket öppnat innan tummarna hann hålla färdigt: ingen session har
      // börjat, och försöket är inte förbrukat. Lådan går tillbaka till
      // AWAITING_LID (CLOSE BOX) i samma läge, så appen gör detsamma —
      // skärmen står kvar på CLOSE THE LID och lock-timern räknas om från
      // noll, precis som lådans AWAIT_LID_MAX_MS gör.
      if (state.phase === 'checking_in') {
        return { ...state, phase: 'awaiting_lid' };
      }
      if (state.phase !== 'active' && state.phase !== 'checked_in') return state;
      return { ...state, phase: 'respite', respiteStartedAt: Date.now() };

    // withPod-kontrollen är spegelvänd mot lock-händelserna: en ansluten
    // låda äger sin egen vila via locket och ska aldrig kunna frysas av
    // telefonens läge, och tvärtom.
    case 'PHONE_LIFTED':
      if (state.phase !== 'active' || state.withPod) return state;
      return { ...state, phase: 'respite', respiteStartedAt: Date.now() };

    case 'PHONE_RESTED': {
      if (state.phase !== 'respite' || state.withPod) return state;
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
        withPod: event.withPod,
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
      // En sen/duplicerad session_ended för en annan seq än den vi tror pågår
      // ignoreras för fasövergången men rapporteras ändå upp (outboxen är källan
      // till sanning för lagring, inte reducerns fas).
      if (state.seq !== null && state.seq !== event.seq) {
        return state;
      }
      return {
        ...state,
        phase: 'ended',
        lastEnded: { seq: event.seq, durationMs: event.durationMs, completed: event.completed, night: event.night },
      };

    case 'RESTORE':
      return {
        ...initialSessionState,
        phase: event.phase,
        withPod: event.withPod,
        seq: event.seq,
        startedAt: Date.now(),
        elapsedBaselineMs: event.elapsedMs,
      };

    case 'RESET':
      return initialSessionState;

    default:
      return state;
  }
}
