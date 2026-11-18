# Pause Pod — kontrakt för pausposter

Version 1, 2026-11-17. Gäller firmware v8.4 och framåt.

Det här dokumentet är det enda stället där formatet bestäms. Lådan, servern
och appen byggs mot det. Ändras något här ska alla tre uppdateras.

## Principer

1. **Lådan äger pausen.** Den har locksensorn och taggläsaren, så bara den vet
   när en paus började och slutade. Appen och servern registrerar, de bestämmer
   inte.
2. **En post, ett format, två transporter.** Hur posten kommer till servern är
   rörmokeri och ska inte synas i formatet.
3. **Servern dedupar.** Därför kan samma paus skickas två vägar utan att
   dubbelräknas, och lådan behöver aldrig välja väg.
4. **Lådan har ingen klocka.** Längden kommer från lådan. Tidpunkten sätts av
   servern.

## Identitet

| Fält | Var det kommer från |
|---|---|
| `box_id` | Lådans ID, finns redan i firmware som `boxIdBle` |
| `seq` | Räknare i lådan, ökar ett steg per paus, sparas i NVS (`next_seq`) |

Primärnyckeln är `(box_id, seq)`. Ett `seq` återanvänds aldrig.

## Postformat

Samma endpoint tar emot båda typerna. JSON, POST.

**Start, skickas när pausen börjar:**

```json
{
  "box_id": "447EF604A7AC",
  "seq": 124,
  "event": "start",
  "started_by": "tag",
  "tag_uid": "048D2A2AF47380",
  "fw": "8.4"
}
```

`started_by` är `"tag"` eller `"app"`. `tag_uid` utelämnas när pausen startats
från appen.

**Slut, skickas när pausen är klar:**

```json
{
  "box_id": "447EF604A7AC",
  "seq": 124,
  "event": "end",
  "duration_ms": 1800000,
  "completed": true,
  "tag_uid": "048D2A2AF47380",
  "ended_ago_ms": 0,
  "source": "box",
  "fw": "8.4"
}
```

- `completed` — `true` om telefonen lyftes ur, `false` om pausen avbröts eller
  räddades efter ett strömavbrott.
- `ended_ago_ms` — hur länge sedan pausen slutade, så servern kan sätta rätt
  tidpunkt för en post som legat i kön. `0` betyder just nu eller okänt.
- `source` — `"box"` om lådan skickade själv, `"app"` om appen
  vidarebefordrade.

## Regler för servern

**Byggt 2026-11-17 i Supabase-projektet PausePod.**

1. **Idempotent på `(box_id, seq, event)`.** Samma event två gånger ger `200`
   och ändrar ingenting. Svaret är då `duplicate`, vilket är ett lyckat svar.
   Dedupen ligger i det unika indexet `pause_sessions_box_seq_unique` på
   `(user_id, box_seq)`, där `box_seq` är strängen `box_id:seq`.
2. **`start`** lagras i tabellen `box_session_starts`, med `started_at` =
   serverns tid. Den skrivs medvetet **inte** till `pause_sessions`, eftersom
   en rad utan längd skulle dyka upp i appens statistik som en paus utan tid.
   Raden tas bort när pausen avslutas.
3. **`end`** skriver pausen till `pause_sessions`. Finns en startnotis används
   dess tid som `started_at`, och slutet räknas som *start + längd*. Finns
   ingen startnotis räknas det baklänges från nu, alltså
   *nu − `ended_ago_ms` − `duration_ms`*.
4. **Kommer `end` från både lådan och appen** vinner den första. Den andra får
   `duplicate`.
5. **Svara `200` på allt som lagrats**, så lådan kan ta bort posten ur kön.
   Svara `5xx` bara vid verkliga fel, så lådan behåller posten och försöker
   igen.

**Vännerna ser pausen medan den pågår.** Startnotisen sätter
`profiles.is_pausing = true` och slutposten sätter den till `false`. Det är
samma flagga som appen redan använder för "pausing now" i Community, så en
lådpaus syns på exakt samma sätt som en app-paus utan att appen behöver
ändras. Valt framför att öppna `box_session_starts` för läsning.

Två kantfall värda att känna till: appen nollar flaggan vid start, för att en
tvångsstängd app annars lämnar någon stående som pausande för evigt. Kommer
appen i förgrunden mitt i en lådpaus släcks alltså flaggan i förtid. Och dör
lådan mitt i en paus står flaggan tänd till nästa gång appen startas.

Funktionerna heter `record_box_session_start()` och `record_box_session()`.
Edge-funktionen `box-session` tar emot båda, och saknas `event` i anropet
behandlas det som `end` — så firmware som redan är ute fortsätter fungera.

`box_session_starts` har RLS påslaget utan policies, alltså bara åtkomlig för
edge-funktionen. Det är avsiktligt.

## Regler för lådan

- **En kö i NVS, ett postformat.**
- **`start`** skickas direkt över wifi när pausen börjar. Misslyckas det görs
  inget försök igen; regel 3 ovan täcker fallet.
- **`end`** läggs i kön. Leveransen försöker wifi först, och Bluetooth om wifi
  saknas och appen är ansluten. Posten tas bort först när någon av vägarna
  kvitterat.
- **`seq`** ökas en gång per paus, innan `start` skickas.

## Regler för appen

- Tar emot en `end`-post över Bluetooth och skickar den vidare till samma
  endpoint med `source: "app"`.
- **Kvitterar till lådan först när posten är säkrad**, alltså när servern
  svarat `200` eller när appen sparat den lokalt för senare. Kvitterar appen
  direkt och sedan tappar posten är pausen borta.

## Lådans wifi-meddelande

Ligger tre eller fler pauser oskickade visar lådan `NO WIFI` plus
"Open the app to reconnect." i fyra sekunder när den vaknar. Har inget nät
någonsin sparats står det `SET UP WIFI` i stället. Finns i firmware v8.4 som
`renderNeedsWifi()`.

Villkoret räknar pauser och inte tid, eftersom lådan inte har någon klocka.

**I steg 4 byts texten mot en QR-kod** som djuplänkar till wifi-inställningen
för just den här lådan, med `box_id` i länken. Lådan ritar redan QR-koder i
registreringsflödet, så det är samma kod med en annan länk. Skälet att vänta
är att koden måste leda till en skärm i appen som inte finns än, och att det
är samma arbete som wifi-över-Bluetooth.

## Det här tas bort i firmware när kontraktet är på plats

- `WifiRecord` och `SessionRecord` → en struct
- `wifiQueue` och `queueBuf` → en kö
- Regeln "varje paus går bara EN väg"
- Den del av `sessionOwner` som bara valde transport. Hur pausen startade
  behålls, men som information till servern (`started_by`), inte som en
  förgrening i koden.

## Nyckeln måste bli densamma på båda vägarna

Granskning av appen (branchen `simpledemo`, `lib/sessionOutbox.ts`) visar att
den **redan** skriver `box_seq` och redan hanterar en krock på det unika
indexet (felkod 23505) som "redan sparad". Grunden finns alltså. Men de två
vägarna bygger olika nycklar:

| | `box_id` | `box_seq` |
|---|---|---|
| Lådan via wifi | `BOX001`, från `x-box-id` | `BOX001:62` |
| Appen via Bluetooth | `447EF604A7AC`, BLE-id:t ur `hello` | `62` |

Så länge det är så kan servern inte se att det är samma paus, och båda
vägarna påslagna ger dubbelräkning.

**Åtgärd, i den här ordningen:**

1. **Lådan** skickar sitt serverkända ID över Bluetooth i handskakningen:
   `boxid:BOX001`. Klart i firmware v8.4. Ett eget meddelande och inte ett
   extra fält i `hello`, eftersom appens parser lägger ihop allt efter
   `hello:` till ett id. Appar som inte känner igen `boxid` struntar i det.
2. **Appen** läser `boxid`, sparar det, och skriver
   `box_id: <boxid>` och `box_seq: `<boxid>:<seq>``, plus `source: 'app'` så
   att vägarna går att skilja åt i efterhand.
3. Därefter dedupar det befintliga unika indexet båda vägarna. Ingen
   serverändring behövs.

Gamla rader behåller sina gamla nycklar. Det är historik och gör ingen skada.

**Appen behöver ingen ny autentisering.** Den skriver direkt till
`pause_sessions` med användarens egen JWT och RLS, inte genom
`box-session`. Lådans nyckel ska alltså aldrig gå genom telefonen.

## Öppna frågor

- **Startnotiser som aldrig får ett slut** ligger kvar i `box_session_starts`.
  Behöver en städning, till exempel en cron som tar bort rader äldre än ett
  dygn.

- Ska servern tidsgränsa en paus som fått `start` men aldrig `end`? Förslag:
  markera den som ofullständig efter ett dygn.
- Ska `fw` användas till något, eller räcker det att den loggas?
