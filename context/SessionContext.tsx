// Håller den pågående pausens tillstånd, så att det överlever ett
// skärmbyte: `app/pausing.tsx` dispatchar, och `app/_layout.tsx` läser
// `phase === 'ended'` för att navigera till sammanfattningen oavsett vilken
// skärm som står framme.
//
// Den matade förr också lådflödet, genom BLEContexts
// meddelandeprenumeration: `session_started` och `session_ended` från lådan
// gick in i samma reducer, och en avslutad lådsession skrevs till
// `lib/sessionOutbox.ts` innan appen ackade. Sedan firmware v8.5 äger lådan
// sina pauser hela vägen och laddar upp dem själv över WiFi, så det finns
// inget att ta emot, inget att acka och ingen kö att hålla. Kvar står
// telefonens egen paus, som alltid dispatchades manuellt.

import React, { createContext, useContext, useReducer } from 'react';
import { initialSessionState, SessionEvent, sessionReducer, SessionState } from '../lib/sessionMachine';

const SessionContext = createContext<{
  state: SessionState;
  dispatch: (event: SessionEvent) => void;
} | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);

  return (
    <SessionContext.Provider value={{ state, dispatch }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession måste användas inom SessionProvider');
  return ctx;
}
