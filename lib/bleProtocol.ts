// Tunt lager mellan BLE-strängar och typade meddelanden. All kunskap om
// exakt textformat bor här — om firmware landar på ett annat format är det
// den här filen som ändras, inget annat.
//
// Sedan firmware v8.5 startar appen aldrig en lådpaus. Lådan äger sina
// pauser hela vägen: taggen, locket, och uppladdningen över WiFi. Bluetooth
// bär därför bara lådans *tillstånd* — vilken låda det är, om den har nät,
// hur mycket batteri den har — och inga händelser i en ritual appen deltar
// i. Det är skälet att `set_mode`, `phone_down`, `phone_up` och
// `session_ack` inte längre kodas här, och att `checkin_complete`,
// `session_started`, `session_ended` och lockhändelserna inte längre
// parsas: lådan skickar dem inte, och en app som väntade på dem skulle
// fastna på en pausskärm för en paus den inte äger.

/** Lådans fas i `state`. v8.5 säger alltid `idle` (med flit — se .ino),
 *  men meddelandet finns kvar och fasen kan komma tillbaka. Egen typ och
 *  inte sessionMachines `SessionPhase`: appens faser är det lådlösa
 *  flödets, och de två ska kunna ändras oberoende av varandra. */
export type BoxPhase = 'idle' | 'active' | 'respite';

export type BoxMessage =
  | { type: 'hello'; boxId: string }
  | { type: 'boxid'; serverBoxId: string }
  | { type: 'ready_to_close' }
  | { type: 'net'; wifiUp: boolean; networkSaved: boolean; queued: number; ssid: string }
  | { type: 'state'; phase: BoxPhase; elapsedMs: number; seq: string }
  | { type: 'battery'; percent: number };

const BOX_PHASES: BoxPhase[] = ['idle', 'active', 'respite'];

function isBoxPhase(value: string): value is BoxPhase {
  return (BOX_PHASES as string[]).includes(value);
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
    // än. Lådan startar den när locket stängs (firmware v8.5+). Ingen skärm
    // läser den än — den är ingången till *CLOSE THE POD TO START*.
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
      if (!phase || !isBoxPhase(phase) || !seq) return null;
      const elapsedMs = Number(elapsedMsRaw);
      if (!Number.isFinite(elapsedMs)) return null;
      return { type: 'state', phase, elapsedMs, seq };
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
