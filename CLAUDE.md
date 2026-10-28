# Pause Pod — protokoll och arkitektur

Källan till sanning för BLE-protokollet är firmwaren:
**[firmware/pausepod_firmware_v7/pausepod_firmware_v7.ino](firmware/pausepod_firmware_v7/pausepod_firmware_v7.ino)**

Detta dokument är destillerat ur den källkoden (inte ur någon separat spec) —
vid osäkerhet, läs `.ino`-filen igen istället för att lita på det här dokumentet
om de skulle divergera efter en firmware-uppdatering.

> **v8 finns** ([firmware/pausepod_firmware_v8/](firmware/pausepod_firmware_v8/pausepod_firmware_v8.ino)):
> v7 plus NFC-taggen och WiFi, utan tumplattor. Lådan kan starta en paus
> **själv** — registrerad Pause-tagg i lådan + locket stängs — och sparar den
> via WiFi (edge-funktionen `box-session` → `record_box_session()` i
> [supabase/box_sessions_nfc.sql](supabase/box_sessions_nfc.sql), som också
> räknar in pausen i kretsen och dagsmålet). En sådan paus syns aldrig över
> Bluetooth: `state` rapporteras som `idle` och varken `lid_*` eller
> `session_*` skickas, annars hade appen sparat den en gång till.
> Appens flöde nedan (`set_mode` → `phone_down` → locket → `phone_up`) finns
> kvar i v8, med en skillnad: utan tummar skickas `checkin_complete` och
> `session_started` direkt när locket stängs. Taggregistreringen (QR-koden)
> står i [lib/tagPairing.ts](lib/tagPairing.ts) och
> [supabase/tag_pairing.sql](supabase/tag_pairing.sql).

## Grundprincip

Appen startar ritualen, lådan äger den sedan hela vägen och producerar alla
händelser. Appen är ett register: den hjälper användaren fram till locket och
tar emot färdiga sessioner efteråt.

**Appen skickar sex notiser: en lokal och fem push, och de två sorterna är
olika hela vägen ner.** De fyra senaste — kretsens chatt, stödförfrågan,
stödsvaret, pausinbjudan — beskrivs under *De sociala notiserna* nedan; de byggdes på
begäran, och varje fick ett eget tak innan den fick finnas.
Räkningen gick 0 → 2 → 0 → 2 → 6, och varje steg var ett beslut. De gamla två
var en vän-push (`is_pausing` false → true) och en lokal dagspåminnelse; båda
revs för att appen kändes som att den *pepprade*. De som finns nu är nya
funktioner byggda från början, inte de gamla återställda. Klientsidan av båda
bor i [lib/notifications.ts](lib/notifications.ts).

**1. Dagspåminnelsen — lokal, från den egna telefonen:**

> **Ready for a pause?**
> 1h 30min left of today's goal.

Klockan 20 lokalt ([`REMINDER_HOUR`](lib/notifications.ts)), högst en per dygn.

**2. Kretsens dagsmål — push, från någon annans telefon:**

> **Anna hit today's goal**
> Celebrate in the chat.

Ägs av [supabase/circle_goal_notify.sql](supabase/circle_goal_notify.sql) och
edge-funktionen `notify-circle-goal-reached`. Beskrivs i sin egen del nedan.

**Att det finns två gör inte en tredje billigare, och skälet är inte
sparsamhet utan form.** Dagspåminnelsen kommer från den egna telefonen och
kan inte växa. Kretsnotisen kommer från andra — men har ett **strukturellt**
tak: en krets är högst 10 personer, man är med i högst tre, och varje person
kan nå sitt dagsmål en gång per dygn. 27 i värsta fall (varje mottagare får
den högst en gång per person), och taket är
primärnyckeln `(user_id, day)` snarare än en regel ovanpå. En notis vars antal
i stället beror på hur aktiva andra är — ett "X pausar nu" — har inget sådant
tak, och det är den gränsen som avgör vad som får finnas. Chatten var en
sådan källa, och fick finnas först när taket flyttades från hur mycket de
andra skriver till hur ofta man själv läser (se *De sociala notiserna*).

**Det är ingen push, och det är hela skälet att den fick finnas.** Bara appen
kan registrera en paus — `pause_sessions` skrivs från det lådlösa flödet
([app/pausing.tsx](app/pausing.tsx)), lådflödets kö
([lib/sessionOutbox.ts](lib/sessionOutbox.ts)) och krasch-återställningen
([app/_layout.tsx](app/_layout.tsx)), alla tre i appen. Resttiden kan alltså
inte ändras medan appen är stängd, och därför är en text som räknas ut vid
schemaläggningen aldrig gammal när den visas. Ingen push-token, ingen trigger,
ingen edge-funktion, inget `pg_net`.

Samma insikt ger de framtida dagarna: har appen inte varit öppen finns ingen
ny session, så resten vid klockan 20 i morgon är hela målet. Därför
schemaläggs ett helt fönster (`WINDOW_DAYS` = 7) i förväg med korrekta
siffror, och fönstret är också en broms — ligger appen oöppnad en vecka
tystnar påminnelsen av sig själv.

**Tre tystnader, och de är funktionen snarare än undantag från den:**

- **Inget dagsmål satt → ingen notis.** Det finns inget tal att räkna ner, och
  den som inte satt ett mål har inte bett om en siffra.
- **Målet redan nått → ingen notis den dagen.** Det är den regeln som skiljer
  en påminnelse från en gnällspik.
- **Behörighet saknas → ingen notis, och ingen klagan.** `syncDailyReminder()`
  frågar aldrig; den läser statusen och tiger.

**Behörigheten frågas på ett enda ställe: när ett dagsmål sparas.**
`enableDailyReminder()` anropas från `setDailyGoal()` i
[lib/circles.ts](lib/circles.ts), bredvid dess `track()` och av samma skäl —
Hem och Kretsen sätter samma tal genom samma funktion, och två anrop hade
glidit isär. Det är också det enda ögonblick frågan är begriplig: användaren
har just lovat sig själv ett tal, och notisen handlar om precis det. Att fråga
i introduktionen hade lagt ett femte steg i ett flöde som kortades från åtta
till fyra; att fråga vid appstart hade frågat om ingenting för den som inte
satt ett mål.

**Texten är medvetet inte "Don't forget to PAUSE!".** Skuld är fel motor i en
app vars löfte är lättnad, och versaler är appens *displaykonvention* — i
notisfältet, bredvid varje annan app, läses `PAUSE!` som skrik. Rubriken
speglar i stället Hems `Ready for a pause?`, så att notisen låter som den
skärm den öppnar.

**Det finns ingen rad i Settings, och ska inte finnas förrän det finns en
andra notis.** Appen har exakt en, så att stänga av appens notiser i OS:et är
att stänga av just den här; en egen växel hade varit en notissektion för en
sak. Omräkningen sker i stället av sig själv, från
[app/_layout.tsx](app/_layout.tsx): vid start, vid `AppState` `'active'`
(dygnet kan ha vänt) och vid `'background'` (där har pauserna hunnit landa).
Den globala `phase === 'ended'`-effekten vore den uppenbara fjärde platsen,
men raden i `pause_sessions` är inte skriven än i det ögonblicket — en synk
där hade räknat med en paus som inte syns i RPC:n. Loggas användaren ut rivs
fönstret: ett utlagt `1h 30min left` mot ingens mål vore värre än tyst.

**Vad som revs då och fortfarande är rivet:**

- **Push-kedjan.** `supabase/notifications.sql` och edge-funktionen
  `notify-friends-pausing` — kedjan `is_pausing` false → true → trigger →
  `net.http_post` → edge-funktion → Expo finns inte. Dagspåminnelsen rör
  ingenting av det.
- **Token-registreringen vid inloggning** och lyssnaren som tog ett tryck på
  en notis till `/pause`. `setNotificationHandler` är tillbaka men med motsatt
  uppgift: den *döljer* notisen som landar medan appen ligger framme (en
  påminnelse om att öppna appen har ingenting att säga den som redan är i
  den). Ett tryck gör inget särskilt — grinden i `app/_layout.tsx` äger
  routningen, och Hem visar ändå samma ring som notisen räknade på.
- **Notissektionen i Settings** ([app/onboarding.tsx](app/onboarding.tsx)).

**Databasrivningen står kvar och är fortfarande inte valfri.**
[supabase/notifications-teardown.sql](supabase/notifications-teardown.sql) körs
i SQL-editorn (samma konvention som resten av mappen), och dagspåminnelsen
ändrar ingenting i den bedömningen: `profiles.is_pausing` skrivs
**fortfarande** av pausskärmen — flaggan bär "pausing now" i Friends — så låg
triggern `profiles_notify_friends_pausing` kvar skulle varje paus fortsätta
posta till Expo för tokens som redan ligger på profilraderna, helt utan
appkod inblandad.

Filen droppar triggern, `claim_friend_pause_recipients()`,
`release_friend_pause_ping()`, `prune_friend_pause_pings()` och tabellen
`friend_pause_pings`, och nollar `push_token` på alla rader. Kolumnerna
`push_token`, `notify_friend_pausing` och `tz_offset_minutes` står kvar oläsa
och oskrivna (kolumner droppas inte i den mappen — samma linje som
`circle_members.daily_target_seconds`). **Dagspåminnelsen läser ingen av dem:**
den är lokal, så dygnsgränsen kommer ur `Date.getTimezoneOffset()` i klienten
precis som ringen på Hem, inte ur `tz_offset_minutes`. `pg_net` droppas inte:
extensionen är delad.

**`expo-notifications` är installerat igen** (`~0.32.17`, SDK 54) och dess
config-plugin är tillbaka i `app.json` med bara `color: "#2e86de"` — appens
accent, så att Androids lilla ikon tonas rätt. Ett eget monokromt notisikon
finns inte; utan det använder Android appikonen. Android-behörigheterna
`POST_NOTIFICATIONS` och `RECEIVE_BOOT_COMPLETED` står uttryckligen i
`app.json` trots att biblioteket deklarerar dem själv i sitt manifest —
explicit, så att manifestet och det här dokumentet inte kan säga olika.
Den andra är vad som gör att ett utlagt fönster överlever en omstart.
`VIBRATE` står kvar och ska stå kvar: [app/call.tsx](app/call.tsx) ringer med
`Vibration.vibrate()`, och notiskanalen sätter med flit
`vibrationPattern: null` — en påminnelse som skakar telefonen motsäger det den
ber om.

**Vill någon ha en tredje notis är det fortfarande en ny funktion.** Den gamla
push-halvan hade ett tak (2 vän-notiser + 1 påminnelse = 3 per dygn), en
strypning på 6 timmar, ett nattfönster på 08–21 räknat ur mottagarens
`tz_offset_minutes`, och en bokning under rådgivande lås så att taket var ett
tak och inte ett riktvärde. Allt det var avvägningar, och de bör göras om från
början snarare än grävas upp ur git. Av de fyra är det bara nattfönstret som
kom tillbaka, och bara för att dess skäl inte var borta: en medlem i en annan
tidszon ska inte kunna knacka klockan tre. De tre andra ersattes av tak som är
strukturella i stället för bokförda — och det, snarare än antalet, är
frågan att ställa om en tredje: **kan den växa av sig själv?**

## De sociala notiserna

> **Anna wrote in the chat** — Tap to read.
> **Anna asked for support** — Send a few words.
> **Anna sent you support** — Open it now.
> **Anna invited you to pause** — Join in.

Fyra triggers i [supabase/social_notify.sql](supabase/social_notify.sql)
(körs för hand efter `circle_goal_notify.sql`, `circle_chat.sql`,
`wishlist.sql` och `pause_invites.sql`), på samma rör som kretsens dagsmål: samma `notify_config`,
samma edge-funktion, samma nattfönster 08–21 i mottagarens tid, och samma
princip att mottagare och text räknas i SQL. Edge-funktionen tar numera en
`channel` och måste deployas om.

**Varje notis har sitt eget tak, och taket är skälet att den fick finnas:**

- **Chatten: en per oläst svit.** `circle_members.chat_notified_at` mot
  `chat_read_at` (eller `joined_at`). Första meddelandet efter att man läst
  knackar, resten är tysta tills man öppnat chatten. Antalet meddelanden
  avgör alltså ingenting — det var det som gjorde chatten till den
  bullrigaste källan, och det är det som är borta. Bokningen och urvalet är
  samma `update … returning`, så två meddelanden samtidigt kan inte båda
  knacka.
- **Stödförfrågan: högst en per avsändare och dygn**, till accepterade vänner.
  Vänlistan har inget tak, så taket sitter i avsändaren:
  `support_request_pings (sender_id, day)`, i avsändarens lokala dygn.
- **Stödsvaret: buntat tills öppnat.** `support_inbox_pings.notified_at`: har
  man redan knackats om ett svar som fortfarande ligger oöppnat
  (`delivered_at is null`), är nästa svar tyst. **Svaren överlever
  förfrågan:** en förfrågan står i 24 timmar (`expires_at`, båda vägarna in,
  se [lib/supportStories.ts](lib/supportStories.ts)), men inkorgen, brickan,
  luren och den här spärren räknar svar på *alla* egna stories — också
  utgångna och borttagna — genom `unopenedResponsesQuery`. Förr räknades
  bara aktiva, och då hade en släckt story både gömt sina svar och tystat
  notisen för alltid. Raden i Friends heter **Support requests** (substantiv,
  alltid synlig); *Ask for support* står kvar där man faktiskt ber.
- **Pausinbjudan: varje inbjudan knackar.** Taket är handen och inte en
  räknare: en inbjudan är handplockad på Hem och valet töms när pausen
  startar, så varje push är en person som just valt en annan. Den kan inte
  växa med vänlistan eller av sig själv — bara av att någon bjuder in igen.
  Bara nattfönstret gäller. Förr var taket en per avsändare och dygn
  (`pause_invite_pings`, tabellen står kvar oläst), och det togs bort på
  begäran: en andra inbjudan samma dag syntes bara i Friends och missades.
  Triggern sitter på `pause_invites` — se *Pausa tillsammans* nedan. (Den
  första versionen satt på `pause_sessions`, takade på tio minuter, och rivs
  av samma fil.)

**Den som filtrerats bort av nattfönstret bokförs aldrig.** Ett chattmeddelande
klockan 23 ska inte äta upp morgonens knackning, och en förfrågan när alla
vänner sover ska inte tysta förmiddagens. Bokföringen sker också först när
`push_enabled()` säger att konfigen är ifylld.

**Ingen av dem bär innehåll.** Chatten säger vem, inte vad. Stödsvaret säger
aldrig vad — läses det på låsskärmen tror appen att det är oläst och
öppningsritualen i [app/support-view-text.tsx](app/support-view-text.tsx) går
förbi. Förfrågan säger inte om vad: ämnet kan vara en punkt ur någons att
göra-lista.

- **Triggers och inte RPC:er**, till skillnad från dagsmålet. Där måste
  bedriften räknas ut; här är händelsen själva inserten, och den görs från
  sex ställen i klienten. Varje trigger har ett `exception when others`-block
  — en knackning som inte gick att skicka får aldrig fälla meddelandet eller
  svaret den hänger på.
- **En Android-kanal per sort** (`PUSH_CHANNELS` i lib/notifications.ts,
  `CHANNELS` i edge-funktionen, `p_channel` i SQL — tre ställen som måste
  stämma). Det är appens av-knapp för en sort i taget, eftersom Settings
  fortfarande saknar notisrader.
- **I förgrunden visas alla fyra** (de handlar om någon annan), **utom
  chatten medan chatten står framme** — `setChatScreenOpen` från
  [app/circle-chat.tsx](app/circle-chat.tsx). Läsmärket flyttas först när
  pollen hämtat meddelandet, så notisen kan hinna landa ovanpå det.
- **Ett tryck:** chatten öppnar kretsens chatt (som dagsmålet), de två
  stödnotiserna och pausinbjudan öppnar Friends. Svaret öppnas inte direkt —
  öppningen är en del av svaret. Pausinbjudan bär pausens id
  (`data.shared_id`), så att Friends kan säga *Anna's pause has ended.* när
  dörren hunnit stängas i stället för att bara inte visa något kort.
- **Behörigheten frågas** (`enablePushNotifications`, tidigare
  `enableCircleNotifications`) när man skapar eller går med i en krets, ber om
  stöd, och skickar eller accepterar en vänförfrågan. Det sista behövs för
  att den som aldrig själv bett om stöd ska kunna nås av vänners frågor.

## Pausa tillsammans

**Man väntar inte på ett ja — man bjuder in till en paus som redan pågår.**
Schemat bor i [supabase/pause_invites.sql](supabase/pause_invites.sql),
klienten i [lib/pauseInvites.ts](lib/pauseInvites.ts). Förr satt inbjudaren på
en väntskärm (`app/pause-invite-waiting.tsx`, raderad) tills vännen svarade:
appen bad en stirra på telefonen, ett nej blev en skärm att läsa, och en
inbjudan som aldrig besvarades hade inget slut.

- **Valet görs på Hem.** Raden ovanför PAUSE
  ([components/pause-invite-row.tsx](components/pause-invite-row.tsx)) säger
  *Invite friends*, eller visar ansiktena och namnen på de valda. Väljaren
  visar en vän som redan pausar nedtonad som *Anna is already pausing…* —
  synlig men inte valbar. Knappen i Friends-listans rad är en genväg dit: den
  lägger till vännen och går till Hem.
- **Inbjudan går ut när pausen startar**, och tas ur valet i
  [app/pausing.tsx](app/pausing.tsx) — inte på Hem — så att den följer med
  vilken väg pausen än startades. Valet töms då: nästa ensamma paus bjuder
  inte in samma personer igen. Ingen inbjudan i nattläge; natten är privat.
- **Dörren står öppen så länge värden pausar, högst 30 minuter.** Två
  spärrar: `closed_at` (värden slutade — pausskärmen, övergivandet och
  krasch-återställningen sätter den) och `expires_at` (den hårda gränsen, för
  när värdens app dör utan att hinna säga till; ett hjärtslag går inte, för
  telefonen ligger nedåt och appen sover). Spärren sitter i
  `join_pause_invite`, klienten gömmer bara utgångna kort.
- **Det finns inget nej.** *Not now* tar bort kortet tyst, och den som
  aldrig hängde på syns ingenstans hos värden. Den som bjöd in och som ingen
  hängde på slutar på Hem som efter en ensam paus.
- **Inbjudan är inte en paus.** Den bor i `pause_invites`, inte som rader i
  `pause_sessions` med `invite_status` som förr. Var och en skriver sin paus
  när den slutar, som vilken paus som helst, med `shared_session_id` och
  `is_shared`. Den gamla modellens RPC:er och kolumner står kvar oanvända.
- **Sammanfattningen** visar en rad per person ur `get_shared_pause_people`
  — *Anna joined in · still pausing*, *Steve joined in · paused 5 min*, och
  för en gäst *Anna invited you · …* — och hämtar om medan någon pausar.
  Inget pronomen. Hälsningen går till dem som slutat, för den hänger på deras
  `pause_sessions`-rad, och den som fortfarande pausar har ingen än.

## Kretsens dagsmålsnotis

> **Anna hit today's goal**
> Celebrate in the chat.

Schema, mottagarlista och text bor i
[supabase/circle_goal_notify.sql](supabase/circle_goal_notify.sql) (körs för
hand i SQL-editorn efter `circles.sql` och `dailygoal.sql`, samma konvention
som resten av mappen). Utskicket går via edge-funktionen
`notify-circle-goal-reached`
([supabase/functions/](supabase/functions/notify-circle-goal-reached/index.ts)).

- **Mottagarna är kretsen, inte vänlistan, och det är hela skälet att den
  fick finnas.** En krets är högst 10 personer och man är med i högst tre
  (`circle_max_per_user()`). Notisen går till alla ens kretsar, ett utskick
  per krets så att trycket landar i rätt chatt, och den som delar två kretsar
  med avsändaren får den bara en gång. Vänlistan har ingen övre gräns, och
  samma notis över den hade varit "X pausar nu" igen med ett annat ord.
- **`profiles.show_stats` gäller inte, och det är ingen ny regel.**
  `get_circle_progress()` ignorerar redan flaggan med samma motivering: inne
  i en cirkel är din andel av ett mål ni satt ihop hela poängen. Det finns
  därför ingen personlig synlighetsväxel för de här notiserna — ska det
  finnas är det en ny flagga, samma linje som kretsmärket på vänkortet.
- **Taket är en primärnyckel.** `daily_goal_achievements (user_id, day)` är
  unik, så en person kan utlösa notisen en gång per dygn hur många pauser hen
  än lägger ovanpå. Det finns ingen `friend_pause_pings`-motsvarighet och det
  är inte en glömska: det som gjorde den tabellen nödvändig — en händelse som
  kunde fyra obegränsat — är borta.
- **Dagen är bedriftens egen, inte kretsens.** Det ser ut att motsäga regeln
  under *Circles* om att en dagsbedrift kräver en delad dygnsgräns, men den
  regeln gällde ett **delat tal**: potten summerar medlemmar mot varandra, och
  då måste alla mena samma sak med "idag". Den här bedriften jämför ingen med
  någon — den säger att Anna nådde *sitt* mål under *sin* dag, och bara Annas
  egen telefon avgör det. Ingen annan behöver vara överens, och därför behövs
  ingen delad gräns.
- **Summan kommer ur de egna `pause_sessions`**, samma källa som ringen på
  Hem (`get_daily_goal_progress`), så notisen kan aldrig påstå något som Hem
  motsäger. Den kom förr ur `circle_pause_ledger`, men med flera kretsar står
  samma paus på flera ledgerrader och "dagens summa" blev en fråga om vilken
  krets man menar.
- **Upptäckten sker i `recordPauseInCircle()`** ([lib/circles.ts](lib/circles.ts)),
  direkt efter `record_circle_pause` och inte före — bedriften räknas ur
  ledgern, och det är den raden som lägger pausen där. Enda stället båda
  pausflödena går genom, av samma skäl som funktionen finns.
  - **Ett eget RPC och inte en gren i `record_circle_pause`.** Det hade varit
    den naturligare platsen, men en ny parameter där skapar en överlagring i
    stället för att ersätta, alltså krävs ett `drop function` — och då måste
    hela kroppen kopieras in i den andra filen. Två kopior av den funktionen
    hade glidit isär vid nästa ändring i `circles.sql`. Priset är ett extra
    anrop per paus.
- **Klienten får inte påstå något.** Den skickar bara sin tidszon; summan,
  målet och jämförelsen läses i RPC:n. Samma princip som
  `record_circle_pause`, som bara tar emot ett `session_id` och läser längden
  själv.
- **Edge-funktionen talar aldrig med databasen.** Mottagarlistan och texten
  räknas fram i SQL och skickas med i anropet, så funktionen behöver ingen
  service-nyckel, kan inte läsa en profil, och kan inte skicka till någon SQL
  inte redan valt. Spärren är `x-pause-secret` mot `PAUSE_NOTIFY_SECRET` i
  dess miljö, och den deployas med `--no-verify-jwt` eftersom anroparen är
  Postgres och inte har någon användar-JWT. Den gamla
  `notify-friends-pausing` gjorde motsatsen och slog upp mottagarna själv.
- **Url och hemlighet bor i tabellen `notify_config`** (inga grants, läses
  bara av `security definer`-funktionen), inte som literaler i SQL-filen —
  filen ligger i git och hemligheten ska inte göra det. Är raderna ofyllda
  blir utskicket en tyst no-op i stället för ett fel vid varje paus.
- **Ingen pronomen i texten, och det är inte en stilfråga.** Appen lagrar
  inte någons pronomen och får inte gissa det ur ett användarnamn, så varken
  "her" eller "his" går att skriva. `today's` bär dessutom något rubriken
  behöver — vilken dag det gäller. Regeln gäller varje framtida notistext.
- **Ett tryck landar i kretsens chatt**, för det är vad notisen ber om och det
  enda stället i appen man kan säga något till en kretsmedlem — det finns
  ingen väg att skicka ett oombett meddelande till en vän. Kallstart hämtas
  med `getLastNotificationResponseAsync` bakom ett färskhetsfönster
  (`COLD_START_TAP_MAX_MS`): utan det hade ett enda tryck skickat appen till
  chatten vid varje start därefter.
- **`push_token` nollas vid utloggning**, i `signOut` och medan sessionen
  fortfarande finns. Det är lärdomen ur teardown-filen gjord till kod: en
  kvarlämnad token tar emot push långt efter att klienten slutat bry sig, och
  det var precis därför databasen måste rivas för hand förra gången.
- **Behörigheten frågas när man skapar eller går med i en krets**
  ([app/circle-create.tsx](app/circle-create.tsx),
  `handleAcceptInvite` i [app/(tabs)/circle.tsx](app/(tabs)/circle.tsx)). Den
  behövs utöver målsparningens fråga, för kretsnotisen handlar om *andras*
  mål — en medlem som aldrig satt ett eget dagsmål hade annars aldrig blivit
  tillfrågad.
- **`setNotificationHandler` skiljer på de två i förgrunden.**
  Dagspåminnelsen döljs (den som är i appen behöver ingen påminnelse om att
  öppna den); kretsnotisen visas (den handlar om någon annan, och att tysta
  den hade gjort funktionen sämst för den mest aktiva användaren). Skillnaden
  görs på `data.type`, vars sträng sätts i SQL och läses i
  `CIRCLE_GOAL_TYPE` — ingen typkontroll fångar ett stavfel över den gränsen.
- Tabellen har **inga grants** och klienten läser den aldrig, precis som
  `circle_pause_ledger`. Allt som ska visas av dagens siffror kommer redan ur
  `get_circle_progress()`. Därför finns den heller inte i
  [types/database.ts](types/database.ts).
- **Flödet i `circle_activity` får ingen rad.** Det var en möjlighet och inte
  ett förbiseende: dagens siffror står redan på kretsflikens *Today*-sida, så
  en rad per medlem och dygn hade lagt till upp till tio rader om dagen utan
  att visa något nytt — och begravt nivåhöjningarna flödet finns för.

**De två kandidaterna som stod här är byggda** — stödsvaret och den delade
pausinbjudan, se *De sociala notiserna* och *Pausa tillsammans*. Väntskärmen
som var pausinbjudans andra halva är riven: ingen väntar längre.

**Och några som är avfärdade, var och en av sitt eget skäl** — inte av ett
gemensamt tak, för skälen är olika:

- **"X pausar nu"** — det var just den som pepprade. N vänner × M pauser om
  dagen, utan övre gräns i någon av faktorerna.
- **Vänförfrågningar och kretsinbjudningar** — ingenting går förlorat på att
  se dem nästa gång appen öppnas.
- **Nivåhöjningar och veckans bedrift** — de är **inte** avfärdade för att de
  skulle peppra; båda är strängare takade än kretsens dagsmål (tio
  nivåhöjningar någonsin, en bedrift i veckan). Skälet är ett annat: de är
  *kretsens* händelser och inte en persons, de landar utan att någon
  mottagare kan göra något åt dem, och flödet i kretsfliken visar dem redan.
  Vill man ha dem är argumentet alltså helt annat än det som gäller här —
  läs inte den här raden som att de vore uteslutna på samma grund.

Allt det bärs av brickorna som finns: kuvert- och samtalskanalerna i Friends,
pricken på chattikonen i Circle, och flikradens två brickor.

**Flikbrickorna är siffror och ska förbli det.** De stod som ett `?` och
visade bara att *något* fanns. Det dolde en bugg: Circle-brickan
räknade enbart kretsinbjudningar, så ett läst chattmeddelande kunde omöjligt
få den att slockna — den som läste `?` som "nytt i chatten" fick en bricka som
aldrig gick ner, och det såg ut som att läsmärket var trasigt. Ett frågetecken
kan betyda vad som helst och går därför aldrig att motsäga; en siffra måste gå
ihop. Det var när den blev en siffra som chatten var tvungen att räknas med.

- **Circle grenar på samma villkor som fliken själv.** Fliken visar
  inbjudningar i tomvyn och bakom `+` i kretsraden, alltså så länge man är med
  i färre än tre kretsar. Brickan gör likadant: olästa chattmeddelanden räknas
  i **varje** krets man är med i, och pendande `circle_invites` räknas bara
  när det finns plats för en krets till.
  - Det andra ledet är en rättad bugg, inte en förenkling. Brickan räknade
    inbjudningar villkorslöst, så den som inte kunde gå med i fler fick en
    etta som ingenting i gränssnittet kunde släcka. Med tre kretsar ligger
    raden kvar som `pending`; fliken säger under kretsraden att den väntar
    och att man måste lämna en krets, men brickan räknar den inte.
  - **Regeln: brickan räknar det fliken visar.** Står det en siffra ska det
    finnas något att trycka på. Ändras grenen i `load()` ska den ändras i
    `fetchCircleBadge()` också — de två är ett par.
  - Olästa räknas med `countUnreadCircleMessages()`, exakt samma anrop som
    pricken inne i fliken gör, mot `circle_members.chat_read_at` (eller
    `joined_at` för den som aldrig öppnat chatten). Pricken står kvar:
    brickan säger *att* något finns, pricken säger *var* i fliken.
- **Friends = vänförfrågningar + öppna pausinbjudningar + oöppnade stödsvar.**
  Inbjudningarna räknas med `countOpenPauseInvites()`, som är samma fråga
  som korten i fliken (`fetchIncomingPauseInvites`) — samma regel som Circle.
- **Bara det som väntar på ett svar räknas, aldrig det som bara hänt.**
  `circle_activity` fylls av varje paus och varje måländring och har inget
  läsmärke — en bricka som räknade flödet hade stått på ett tal för alltid och
  blivit omöjlig att nolla. Det är samma fälla som `?` var, bara med siffror.
- Taket är `9+` (`BADGE_MAX`), samma form som inkorgsbrickorna i Friends redan
  använder. Brickan har fast höjd, så det är bredden som växer med texten —
  en siffra som inte får plats i sin cirkel är den andra sidan av samma bugg
  som typskalans golv finns för att hindra.
- De två brickorna delar en `badgeStyle`. Två brickor på samma rad som ser
  olika ut är värre än en som ser fel ut; ändras måtten i den ena ska den
  andra följa med, och det gör den av sig själv nu.

Kretsinbjudningar syns alltså som förut först när mottagaren själv öppnar
appen. Följden är känd och accepterad. Kretsens chatt, stödförfrågningar,
stödsvar och pausinbjudningar knackar numera — se *De sociala notiserna*.

- **Alla skrivningar av `profiles.is_pausing` går genom
  [lib/pausingFlag.ts](lib/pausingFlag.ts).** Flaggan bär numera **en** sak:
  "pausing now" under en väns namn i Friends. (Den bar förr också triggern
  bakom vän-notisen, som bara fyrade på false → true; det är den halvan som
  försvann.) Den skrevs en gång med lösa `.update()` från tre ställen som inte
  inväntade varandra, och två HTTP-anrop har ingen inbördes ordning — ett
  `false` kunde landa efter det `true` det skulle föregått. En fjärde lös
  `.update({ is_pausing })` någonstans återinför det.
  - Pausskärmens montering sätter `true`, dess cleanup `false`. Tvångsstängs
    appen körs cleanup:en aldrig, så [app/_layout.tsx](app/_layout.tsx) nollar
    flaggan **en gång per appstart, villkorslöst**: vid start pausar man inte.
    Utan den stod en vän som pausande i all evighet. (Nollningen hade förr ett
    andra skäl — att en flagga som stod kvar på `true` gjorde övergången
    false → true omöjlig och därmed tystade nästa pausnotis. Det skälet är
    borta med notisen; det första räcker.) Fortsätter en lådpaus över
    omstarten sätts `true` igen när rutten monterar `/pausing`, och att den
    ordningen håller är just vad den delade kön är till för.
  - Städningen låg förr i krasch-återställningen, bakom både en checkpoint
    (som bara det manuella flödet skriver) och ett `duration < 5`-avhopp. Lägg
    den inte tillbaka där.
- **"pausing now" i Friends pollas var 5:e sekund**, inte bara via realtime
  ([`fetchPausingNow`](app/(tabs)/friends.tsx)). Realtime-kanalen på `profiles`
  kräver att tabellen ligger i publikationen `supabase_realtime`, och den är av
  som förval per tabell — utan pollningen gick statusen bara att framkalla med
  en dragning nedåt, eftersom `fetchAll()` bara körs vid montering och flikar
  inte avmonteras när man byter flik. **`profiles` ligger medvetet inte i
  publikationen:** RLS är av på tabellen, så realtime skulle skicka hela raden
  till varje inloggad klient vid varje uppdatering. Fem sekunder är inte värt
  det. Ska den in måste RLS på först. (Argumentet pekade förr på `push_token`
  som det värsta i raden. Kolumnen är nullad nu, men raden bär fortfarande
  allt annat på profilen, och en tabell utan RLS i en realtime-publikation är
  fel oavsett vilken kolumn man råkar bry sig om.)
- **Statusraden under en vän visar bara veckans aktivitet** — *pausing now*,
  minuter, timmar, *paused yesterday*, *paused 6 days ago*, sedan ingenting
  (`STATUS_MAX_HOURS` = en vecka i `friendStatusText`). Återkopplingen var
  att en lång tid sedan senaste pausen gjorde läsaren själv omotiverad: en
  siffra om vad någon *inte* gjort. Grövre enheter (*2 weeks*, *1 month*)
  övervägdes och föll — de dyker bara upp när det gått länge och blir då
  listans tyngsta rader. En inbjudningsknapp med ord (*Invite*) där raden
  är tom prövades och togs bort; ⏸+ ser likadan ut på varje rad.

**Introduktionen bor i [app/intro.tsx](app/intro.tsx)**, med ett steg per
fil under [components/intro/](components/intro/). Den ersatte de gamla
`onboarding-flow.tsx` och `onboarding-complete.tsx`, som är raderade.

**Den är tre skärmar: hälsning, namn, och det sociala.** Den var åtta, sedan
fyra steg plus ett kvitto (hälsning, namn, lådan, dagsmål, kvitto). Lådsteget,
dagsmålet och kvittot togs bort på begäran: målet sätts på Hem (*Set a daily
goal*), och lådan är nedtonad (`POD_COMING_SOON`). I stället kom
[step-social.tsx](components/intro/step-social.tsx) — *Better together*, tre
block (**Friends / Support / Circle**) som tonar in efter varandra. Varje
block säger *vad* funktionen är och *varför* den finns; avsikten är det som
inte går att gissa sig till av knapparna senare. En första version hade en
liten attrapp att trycka i per funktion och var för pillig — man fick lära sig
attrappen före funktionen. Lägg inte tillbaka interaktionen. Sidan är sista
steget och sparar (`finish()`); ett upptaget namn visas där med en uppmaning
att gå tillbaka.

Lådsteget ([step-box.tsx](components/intro/step-box.tsx)), målsteget och
kvittot ligger kvar som oanvända filer. **När `POD_COMING_SOON` sätts till
`false` bör lådsteget tillbaka** — se nästa stycke.

Tidigare revs tre steg, och vart och ett hade redan en bättre hemvist:

- **Tema** — [app/onboarding.tsx](app/onboarding.tsx) (Settings) äger väljaren,
  valet sparas per enhet och gäller redan innan någon loggat in. Att fråga här
  var att låna ett val som inte var introduktionens.
- **Aktiviteter** — frågades innan användaren sett vad en paus är i den här
  appen, alltså exakt den sortens fråga som gör en tröskel hög.
  [app/pause.tsx](app/pause.tsx) ställer samma fråga i det ögonblick den
  betyder något, och Settings äger redigeringen inklusive egna aktiviteter.
  **Plusknappen vid `WHAT WILL YOU DO?` är därför ett frågetecken nu.** Pluset
  öppnade en lista att lägga till ur, och den listan står tom så fort alla
  aktiviteter är framme som förval — `All intentions have already been added.`
  var vad varje ny användare mötte. Tillägget sparades dessutom aldrig, så
  nästa paus började om från samma rad. Frågetecknet säger i stället var valet
  bor och leder dit (*GO TO SETTINGS*). Priset är att den som smalnat av sin
  lista inte längre kan plocka in en aktivitet bara för idag — den vägen går
  nu via Settings, och håller i stället.
  **Priset var att pausskärmens kategorirad blev tom**, eftersom
  `getSelectedCategories()` returnerade `[]` när inget sparats och raden
  renderas på `categories.length > 0`. Den grenen ger numera
  `DEFAULT_CATEGORIES` i stället — och den sitter kvar i `catch`, inte efter
  en längdkoll, just för att skilja "aldrig valt" (`readDoc` kastar) från
  "medvetet tömt i Settings" (ett sparat `[]`). Den som tömt sin lista
  behåller sitt val.
- **Stödförfrågningar** — visade ett story-kort för någon som ännu inte har en
  enda vän att fråga. Friends-fliken har en synlig plusknapp för samma sak, och
  den dyker upp när det finns någon att skicka till.

**Lådsteget är borta så länge lådan inte går att välja, och inte längre.**
Lådan är den enda delen av produkten som inte finns i telefonen, och den som
inte vet att den existerar hittar aldrig dit av sig själv — och tummarnas
grind står ingen annanstans innan telefonen ligger i en stängd låda.

Wrapped introduceras ingenstans, och ska inte göra det: den sammanfattar en
historik som en ny användare per definition inte har. Samma logik som
kategorierna — ytan presenterar sig när den har något att visa.

**Och den går att hoppa över helt — på första sidan, ingen annanstans.**
*Set up later* uppe till höger i [app/intro.tsx](app/intro.tsx), bara på första sidan,
är en dörr och inte en nödutgång: man bestämmer sig innan man gått in. Ett skip
i foten på varje steg hade gjort flödet till något man förhandlar sig igenom.
Den hette inte *Skip for now* med flit — det gjorde målstegets länk, och två
sorters hopp med samma ord i samma flöde är precis det som gör en kort
introduktion förvirrande igen. Målsteget är borta, men ordet ska fortsätta
vara ledigt om det kommer tillbaka.

- **Skippet skriver inte `onboarding_completed`, och det är hela poängen.**
  Den flaggan betyder exakt en sak: att kvittots skrivning gått igenom. Sattes
  den av ett skip hade servern ljugit om att introduktionen körts, och
  eftersom det är samma flagga grinden läser hade användaren förlorat
  introduktionen för alltid i utbyte mot att slippa den en gång. I stället
  finns `deferIntro()`/`isIntroDeferred()` i
  [lib/introPrefs.ts](lib/introPrefs.ts) — per enhet, som temat och det
  parkerade målet.
- **Grinden i [app/_layout.tsx](app/_layout.tsx) läser båda och släpper förbi
  på endera.** Overlayen väntar också på båda: en gate som utvärderas innan
  AsyncStorage-läsningen landat skickar till `/intro` i en hundradel innan den
  ångrar sig, och blinket syns. `null` betyder "inte läst ännu" för båda.
- **Vägen tillbaka är *Finish setting up* under ringen på Hem**, i samma slot
  och form som *Set a daily goal* — den andra tystas medan den här syns, för
  två uppmaningar på samma rad är brus och målet är ändå ett av stegen bakom
  knappen. Den ligger **utanför** bådas grenar i
  [app/(tabs)/index.tsx](app/(tabs)/index.tsx): en skippare kan ha satt ett mål
  direkt på Hem, och en puff som bara renderades i den mållösa grenen hade
  försvunnit just när hen började använda appen. Den läses om vid varje fokus,
  eftersom flikar inte avmonteras.
- **Den går inte att avfärda, och behöver inte göra det:** den rivs av
  `finish()` när introduktionen faktiskt körts.
- **Introduktionen förifyller namn och foto ur den lokala profilen när den
  körs om.** Den som sköt upp introduktionen kan ha satt sitt namn i
  profilskärmen under tiden, och utan seedningen skriver `finish()` över det
  med sin fallback ur `user_metadata`. `'Yourself'` seedas inte — det är
  `getProfile()`s svar när ingen profil finns, alltså frånvaron av ett namn.
  Målet behöver ingen motsvarighet: `applyPendingDailyGoal()` skriver aldrig
  över ett mål som redan är satt.
- En egen rad i Settings för att köra om introduktionen finns **inte**. Puffen
  står kvar tills introduktionen är körd, så vägen är aldrig borta — en rad
  där vore en annan funktion (köra om den frivilligt), inte ett skyddsnät.
Grinden är oförändrad: `profiles.onboarding_completed` avgör, `AuthContext`
läser den, och `app/_layout.tsx` skickar den som inte kört den till `/intro`.
Flaggan sätts först i sista steget, tillsammans med namn och avatar — sätts
den tidigare och en uppladdning faller har användaren tappat sin chans att
fylla i namnet utan att veta om det.

`AuthContext` ser dessutom till att profilraden finns (insert om den saknas,
aldrig överskrivning). Det var förr onboardingens jobb ensamt; nu är det en
garanti som gäller även om introduktionen avbryts.

> **Obs:** [app/onboarding.tsx](app/onboarding.tsx) är **Settings**-skärmen
> trots filnamnet — den har aldrig varit onboarding och ska inte raderas.

**Lådläget är nedtonat tills lådan finns.** `POD_COMING_SOON` i
[app/pause.tsx](app/pause.tsx) gör WITH PAUSE POD otryckbar, dämpar den och
byter anslutningsraden (`Ready`/`Connect`) mot **COMING SOON**. Allt bakom
knappen står orört — `sendSetMode`, BLE-kollen, routningen till `/placeinbox`,
hela `med-låda`-grenen i `handleCheckIn`. Sätt konstanten till `false` och
läget är tillbaka i exakt samma skick; att det är en konstant och inte en
bortkommenterad gren är hela avsikten. Knappen **döljs inte**: att lådan finns
är en del av vad appen är (introduktionens lådsteg står kvar av samma skäl),
och en knapp som säger varför berättar det, medan en borttagen knapp bara gör
valskärmen till ett val mellan en sak. Allt som följer nedan beskriver alltså
protokollet som det är och kommer att vara, inte som det går att nå från
gränssnittet just nu.

**Valskärmen går att stänga av: `SHOW_PAUSE_SETUP_VIEW`** i
[lib/pauseFlow.ts](lib/pauseFlow.ts) (förval `true`, så att ingen tester ser
flödet byta form mitt i ett test). Med `false` hålls PAUSE på Hem in och
startar en lådlös paus direkt, och *I'll take a pause* efter ett stödsvar
(fem skärmar, alla via `openPauseStart()`) startar den utan att hållas —
de är redan ett avsiktligt val. Intentionen ställs då bara efteråt (se
taggarna nedan). Valskärmen står kvar i koden.

- **`startPhonePause()` är en kopia av den lådlösa grenen i `handleCheckIn`**
  (samma rutt, parametrar och händelse, plus `skipped_setup: true`). Den
  grenen rördes inte, för app/pause.tsx ändras bara i gest och utseende —
  ändras den ena måste den andra följa med.
- **Lådans väg går inte att nå utan valskärmen**, och det är avsiktligt:
  `set_mode` skickas därifrån, och lådan startar aldrig en paus på egen hand
  (se ovan). Det är firmware-arbete, inte en flagga.
- **Finish på pausskärmen hålls också in** ([app/pausing.tsx](app/pausing.tsx),
  båda knapparna — den under klockan och den i *PUT PHONE FACE DOWN*), och den
  är **röd** (`Palette.danger`), inte accent: att avsluta ska inte se ut som
  knappen man trycker på för att börja. Samma `finishPause` som förut; filen
  ändras bara i gest och utseende.
- **Ingen instruktion står under knappen.** Fyllningen säger själv att det är
  ett håll; först efter ett för kort tryck syns *Keep holding* en stund,
  svävande under knappen utan att ta plats i layouten (samma för CHECK IN).
  En permanent *Hold to start* stod där en kort tid och togs bort som störande.

**CHECK IN hålls in, den trycks inte.** `HOLD_TO_START` (på) i
[app/pause.tsx](app/pause.tsx) och `HOLD_TO_START_MS` (700, delad med PAUSE på
Hem i lib/pauseFlow.ts) gör knappen till en
[HoldToStartButton](components/hold-to-start-button.tsx): fyllning under
hållet, lätt haptik vid start och fast vid utlösning, *Keep holding* vid ett
för kort tryck, och knappens `activate`-åtgärd som direkt utlösning för
skärmläsare och brytarstyrning. Båda grenarna anropar samma `handleCheckIn` —
gesten är det enda som skiljer, och ingenting i lådvägen (`sendSetMode`,
routningen till `/placeinbox`) rörs av valet.

**Efter en paus: en ensam paus slutar på Hem.** Sammanfattningen
([app/pausesummary.tsx](app/pausesummary.tsx)) lämnar en lapp
(`setPendingPauseTag` i lib/pauseTags.ts) och byter sig själv mot Hem —
rutten dit sätts i app/_layout.tsx, som inte rörs. Hem läser lappen vid
fokus: klockan ringer, dagens siffra hämtas om efter 1,5 s så att strecken
stiger med pausen, och saknar pausen intention glider kortet *What did you
do instead?* upp underifrån ([components/pause-tag-sheet.tsx](components/pause-tag-sheet.tsx))
medan heron lyfts så att siffran och målraden syns ovanför det. En **delad**
paus stannar på sammanfattningen, för den har hjärtat till partnern — men
frågan ställs ändå på Hem: *Back to start* lämnar samma lapp (utan klocka,
den har redan ringt). Sammanfattningen handlar bara om vem man pausade med,
och frågan står på ett och samma ställe efter varje paus.

**Återkomsten ska belöna, och den gör det med fakta och färg — inte med
beröm.** Användare tyckte att efter-pausen var platt. Därför:

- **Siffran räknar upp på Hem.** Dagens förra summa står kvar tills pausens
  rad landat (`countHold`), sedan räknar siffran upp (`COUNT_UP_MS`) medan
  ringen glider efter, och när den landar kommer en haptik och en
  konfettiskur ur ringen — större om pausen tog en över dagsmålet.
- **Skuren** ([components/celebration-burst.tsx](components/celebration-burst.tsx))
  är wrapped-spektrumet, guldet och accenten, med fasta tal och **inget
  grönt** (grönregeln). Ingen skur med reducerad rörelse; haptiken står kvar.
- **Taggkortet svarar på ett val:** tiden står i grönt som kortets rubrik (se grönregelns femte undantag),
  chippen har var sin ton (`colorful` på `PauseTagChips`, samma
  toner som pausens kort i statistiken), och ett tryck fyller och studsar chippen, ger
  en skur och en haptik och byter frågan mot en rad som *Pages over
  scrolling.* (`REWARD_LINES`) innan kortet glider ner. Svaret är
  optimistiskt; faller sparningen visas felraden som förut. Raderna är tre
  till fyra ord, utan pronomen och utan bock.

**Efter en delad paus skickar man ett hjärta, inte en hälsning.** Ett
textfält på 200 tecken med *Send* och *Not this time* var för mycket att be
om precis efter en paus; nu är det ett hjärta som fylls vid ett tryck och
töms vid nästa. Det går till dem som redan slutat (deras rad i
`pause_sessions` är det hjärtat hänger på) och syns i statistiken som
avsändarens ansikte med ett litet hjärta, på mottagarens paus.

- **Egen tabell, `pause_cheers`** ([supabase/pause_cheers.sql](supabase/pause_cheers.sql),
  körs för hand efter `pause_invites.sql` och `sleep.sql`) — inte en ny
  `message_type` i `pause_messages`, vars check skapades utanför repot. Ett
  hjärta har inget innehåll och inget lästillstånd, och primärnyckeln
  `(session_id, sender_id)` gör att det finns ett per person och paus.
  Klientsidan är [lib/pauseCheers.ts](lib/pauseCheers.ts).
- Insert kräver `can_cheer()`: den andras paus, en riktig paus och inte en
  natt, i en delad paus man själv var med i. Bara avsändaren och mottagaren
  kan läsa raden.
- **Ingen notis.** Antalet hjärtan beror på hur aktiva andra är — se
  notisavsnittet högst upp.
- Gamla hälsningar ligger kvar i `pause_messages` och visas som förut,
  bakom kuvertet på kortet.
- Hjärtats kulör är `dangerSoft`, rosa: ett hjärta läses bara som ett hjärta
  i den färgen. Det är inte `danger`, som är Finish och raderingar.

**En paus utan intention kan taggas efteråt** — på Hem enligt ovan, efter
både ensamma och delade pauser: intentionerna som chips och ett *Skip*,
bara för pauser på minst en minut som startade utan intention, och aldrig som
ett hinder.
Skrivningen bor i [lib/pauseTags.ts](lib/pauseTags.ts) och är en enda:
`pause_sessions.intention` på en egen rad, med samma etikett pausskärmen
skriver. Tre saker att veta:

- **Sammanfattningen har inget sessions-id**; raden skrivs av pausskärmen i
  samma stund som `_layout.tsx` byter rutt, och ingen av dem rörs för det
  här. Raden letas upp — senaste egna paus med samma längd (±2 s) inom 15
  minuter, ett nytt försök efter 1,2 s. Hittas ingen sparas ingenting och
  kortet säger det.
- **Uppdateringen räknar ändrade rader** (`.select('id')`): RLS som nekar ger
  inget fel i PostgREST, bara noll rader.
- **I statistiken går taggen att sätta, byta och ta bort** på varje paus:
  taggen (eller *+ Add tag*) öppnar samma chips under kortet, och *Remove
  tag* skriver `null`. Där är id:t känt, så ingen rad letas upp. Chippen
  markeras oavsett om raden bär en etikett (`FOCUS`) eller ett id (`focus`,
  som lådflödets kö skriver).
- **Pausens kort i statistiken tar färg av taggen**: intentionens emoji i
  en tonad skiva, en ton över kortet och en kant i samma ton —
  `intentionTone()` i [components/pause-tag-chips.tsx](components/pause-tag-chips.tsx),
  samma ton som chippet på taggkortet efter pausen. Varje inbyggd
  intention har en egen kulör ur `INTENTION_TONES` — pastell i mörkt läge,
  samma kulörer djupare i ljust, eftersom tonen också är etikettens text.
  Egna intentioner får en av de tolv ur sitt id. Tonen följer
  kategorins id, inte dess plats i listan, så att den inte byter färg när
  någon ändrar sina val. En otaggad paus står i rummets blå med pausens
  symbol. Chippen under kortet är också färgade (`colorful`).
- **Ett tryck vänder kortet** ([components/flip-card.tsx](components/flip-card.tsx)),
  och baksidan ([lib/pauseFacts.ts](lib/pauseFacts.ts)) har tre rader: en
  rekordrad som bara står när den är sann (längst hittills, längst den
  veckan, *your 3rd walk this month*, tidig/sen), ett citat, och när
  (`Tue 06:12 – 06:30`). Citaten (`PAUSE_QUOTES`, 50 st) är egna rader och
  tillskrivs ingen, och delas ut efter pausens plats i tidsordning — de
  första 50 pauserna får 50 olika. Uppskattningar per tagg (≈ 14 pages) och
  dagens summa stod där en kort stund och togs bort på begäran. Ett kort i
  taget står vänt.
- **Kretsens flöde får inte taggen** — `circle_activity` skrevs när pausen
  sparades. Ska taggen synas där krävs en ny RPC, och det är ett eget förslag.
- Inga att göra-punkter som taggar än: de hade kunnat bli ens "top intention"
  i wrapped, som vänner ser. Det kräver en ändring i wrapped först.

**Lådan startar aldrig en paus på egen hand.** Utan ett `set_mode` från appen
händer ingenting när locket stängs — lådan har ingen sensor för om det ligger
en telefon i den, så ett stängt lock på en tom låda loggade annars en riktig
paus. `AWAITING_LID` (enda vägen in till `CHECKING_IN`) nås bara via
`set_mode`/`phone_down`.

BLE: Service UUID `12345678-1234-1234-1234-123456789012`,
Characteristic UUID `abcdefab-cdef-abcd-efab-cdefabcdefab` (notify + write).

## Ritualen (v7)

1. Användaren väljer paus i appen → `set_mode:<läge>:<UP|DOWN>:<sekunder>`
   (lådan parsar inte innehållet — bara att något kom räknas. Den sätter
   `phonePlaced = false` och går till `AWAITING_LID`, visar **PLACE PHONE IN **)
2. Telefonen läggs ner → appen skickar `phone_down` → lådan visar **CLOSE BOX**.
   Reses telefonen upp igen skickar appen `phone_up` och båda går tillbaka till
   **PLACE PHONE IN BOX** — steget kan upprepas fritt, och lådans nedräkning
   börjar om vid varje vändning.
3. Locket stängs → lådan skickar `lid_closed`. Bara om fasen är
   `AWAITING_LID` (dvs appen har bett om en paus) går den till `CHECKING_IN`
   och visar en tom ring med **HOLD TO START** — annars skickas `lid_closed`
   men ingenting mer händer. Öppnas locket igen innan tummarna hållits
   färdigt går lådan tillbaka till steg 2 (**CLOSE BOX**), inte till loggan —
   steget kan alltså upprepas hur många gånger som helst.
4. Båda tummarna hålls 0,9 s (`CHECKIN_FILL_MS`) → lådan skickar
   `checkin_complete` **och** `session_started:<seq>` i samma andetag,
   startar klockan, och spelar en startceremoni (bock → PAUSE STARTED →
   1-2-3-4-5 → logga tonas in, ~8,4 s totalt). Klockan går redan under
   ceremonin.
   - **Incheckningen är en grind, inte bara ceremoni:** en paus börjar
     aldrig av sig själv. Checkar ingen in inom `CHECKIN_TIMEOUT_MS` (30 s)
     faller lådan tillbaka till `IDLE` utan att någon paus räknats — nytt
     försök kräver att locket öppnas och stängs igen. Skälet är att lådan
     inte kan veta om det ligger en telefon i den: ett stängt lock på en tom
     låda loggade annars en riktig paus. Appens reducer ska ändå aldrig
     villkora på att `checkin_complete` och `session_started` kommer i en
     viss ordning — de skickas i samma andetag och båda kan tappas var för
     sig.
5. Pausen löper. Tummarna gör inget längre under en aktiv paus förutom att
   toggla vilken info som visas (`ACTIVE` ↔ `SHOWING_TIME`) — ingen
   utcheckningsgest finns kvar.
6. Locket öppnas → `lid_opened`, lådan fryser klockan, visar **ON HOLD** med
   en krympande ring, 30 s frist (`RESPITE_MS`). Stängs locket igen innan
   fristen går ut fortsätter pausen (`ACTIVE`) där den var.
7. Telefonen lyfts → appen skickar `phone_up` → lådan avslutar pausen
   (`completed = 1`) **men bara om fasen är `RESPITE`** (dvs bara om locket
   redan är öppet). Går fristen ut utan `phone_up`: `completed = 0`.
   Appen bör alltså bara skicka `phone_up` medan den vet att en session
   pågår (efter `session_started`, före `session_ended`) — se
   [app/_layout.tsx](app/_layout.tsx)s globala lyft-detektering.

## Protokoll — Lådan → Appen (notify)

| Meddelande | Betydelse |
|---|---|
| `hello:<box_id>` | Skickas direkt vid anslutning |
| `state:<fas>:<elapsedMs>:<seq>` | Nuläge. Fas: `idle`, `checking_in`, `checked_in`, `awaiting_lid`, `active`, `respite` (`stats`/`ended` mappas till `idle`, `showing_time`/`checkout_arming`/`checkout_confirm` till `active` — se `phaseName()`) |
| `battery:<0-100>` | Vid anslutning, sedan var 5:e minut |
| `touch_begin:<left\|right>` / `touch_end:<left\|right>` | Tumplattorna. Appen loggar, renderar inget. |
| `checkin_complete` | Tummarna höll färdigt 0,9 s |
| `session_started:<seq>` | Klockan går. Kan komma utan föregående `checkin_complete` (se ceremoni-fallback ovan). |
| `lid_closed` / `lid_opened` | Hall-sensorn |
| `session_ended:<seq>:<durationMs>:<completed>:<ageMs>` | Färdig session. `completed=1` vid lyft under `RESPITE`, `0` vid utgången frist eller för kort session. `ageMs` är hur länge sedan den slutade — `0` för färska. **Undantag:** en session återställd från en krasch (`recoverCheckpoint()`) rapporterar alltid `ageMs=0` oavsett hur länge den faktiskt legat i kön, eftersom lådan inte sparar en verklig sluttid för den — en firmware-begränsning, inte ett appfel. |

## Protokoll — Appen → Lådan (write)

| Meddelande | Skickas när |
|---|---|
| `set_mode:<läge>:<UP\|DOWN>:<sekunder>` | Paus vald i appen. Innehållet parsas inte av lådan idag — bara att meddelandet kommer räknas. Skicka `set_mode:session:UP:0` tills en längdväljare finns. |
| `phone_down` | Telefonen ligger platt (appens accelerometer). Rapport om läget, inte en order — lådan agerar på den under `AWAITING_LID` (sätter `phonePlaced`, visar **CLOSE BOX**) och ignorerar den i övriga faser. |
| `phone_up` | Telefonen är inte längre nedlagd. Samma sorts rapport, och fasen avgör innebörden: under `RESPITE` avslutas pausen (`completed = 1`), under `AWAITING_LID` nollas `phonePlaced` och displayen går tillbaka till **PLACE PHONE IN BOX**. I övriga faser händer ingenting. Skicka den bara när appen vet vilket av de två lägena den är i — `_layout.tsx` för det första (medan en session pågår), `placeinbox.tsx` för det andra (medan reducern står i `awaiting_lid`). |
| `session_ack:<seq>` | Varje gång ett `session_ended` tagits emot och sparats lokalt |

`time_sync:` tas emot av lådan men ignoreras medvetet — skicka det inte.

## Fyra krav som tappar data om de missas

1. **`device.requestMTU(185)`** direkt efter connect, före
   `monitorCharacteristicForService`. Standard-MTU ger 20 byte nyttolast;
   `session_ended:12:1847000:1:0` är längre. iOS förhandlar upp automatiskt,
   Android gör det inte — meddelanden kapas tyst annars.
2. **Acka alltid**, efter att sessionen skrivits till lokal lagring — inte
   före. Lådans kö (`queueBuf`, max 50, `sendNextBacklog()` skickar om var
   3:e sekund utan ack) töms bara av `session_ack:<seq>`.
3. **Deduplicera på `seq`** — unik och stigande per låda. Lådan skickar om
   efter `ACK_TIMEOUT_MS` (3 s) utan ack, så samma session kan komma flera
   gånger.
4. **Sluttid = `Date.now() - ageMs`**, inte mottagningstiden. Köade/omskickade
   sessioner har `ageMs > 0`.

Status i appen: alla fyra är implementerade. Se
[context/BLEContext.tsx](context/BLEContext.tsx) (MTU),
[context/SessionContext.tsx](context/SessionContext.tsx) (acka-efter-lagring,
`recordedAt = Date.now() - ageMs`),
[lib/sessionOutbox.ts](lib/sessionOutbox.ts) (dedupe på `boxId`+`seq`).

## Kända firmware-begränsningar (kan inte fixas i appen, bara hanteras)

- **Tysta timeouts vid `AWAITING_LID` och `CHECKING_IN`:** stänger ingen
  locket inom `AWAIT_LID_MAX_MS` (90 s), eller checkar ingen in inom
  `CHECKIN_TIMEOUT_MS` (30 s) efter `lid_closed`, går lådan tillbaka till
  `idle` **utan att skicka något meddelande**. Appen kan alltså inte få veta
  det av lådan och stod förr kvar på **CLOSE THE LID** i all evighet.
  [app/placeinbox.tsx](app/placeinbox.tsx) speglar numera båda gränserna med
  egna klient-timers (`ABANDON_*`-konstanterna) och landar i sin
  `abandoned`-vy när de går ut. Marginalen `GRACE_MS` ligger alltid **efter**
  lådans gräns — lådan ska falla först, annars kan appen hinna lämna skärmen
  precis medan pausen faktiskt startar. Nytt försök kräver ändå att locket
  öppnas och stängs igen. Det här är numera den **enda** vägen till
  `abandoned`: ett öppnat lock tar försöket tillbaka till **CLOSE BOX** i
  stället för att avsluta det (se nästa punkt).
- **`lid_opened` under `CHECKING_IN` dödar inte längre försöket:** öppnar man
  locket för att titta på displayen innan tummarna hållits går lådan tillbaka
  till `AWAITING_LID` och visar **CLOSE BOX** igen (den satte förr `idle`, och
  appen svarade med sin `abandoned`-vy — att titta i lådan är inte samma sak
  som att ångra sig). `phonePlaced` sätts `true` på vägen tillbaka: locket har
  varit stängt, alltså ligger telefonen i lådan. Reducerns `LID_OPENED` speglar
  det med `checking_in` → `awaiting_lid`, så `placeinbox.tsx` står kvar på
  **CLOSE THE LID**. Locket kan därmed stängas flera gånger under ett och
  samma försök — båda sidors nedräkningar (`AWAIT_LID_MAX_MS` respektive
  `CHECKIN_TIMEOUT_MS`) startar om vid varje växling, och det är fortfarande
  bara de tysta timeouterna som avslutar försöket.
- **`phone_down` som inkommande meddelande till appen är dödkod:** lådan
  skickar aldrig `phone_down` som notify (bara `hello`/`state`/`battery`/
  `touch_*`/`checkin_complete`/`session_started`/`lid_*`/`session_ended`).
  [lib/bleProtocol.ts](lib/bleProtocol.ts) har ändå kvar en parse-gren och
  [lib/sessionMachine.ts](lib/sessionMachine.ts) en reducer-case för det —
  ofarligt men oanvänt i praktiken.
- **`MIN_SESSION_MS = 5000`** i firmware är ett testvärde (kommentar i
  källkoden: sätt till `60000` innan skarp drift). En session kortare än
  detta kastas helt av lådan — inget `session_ended` skickas, appen får
  aldrig veta att den existerat.

## App-arkitektur, kort

- [context/BLEContext.tsx](context/BLEContext.tsx) — BLE-anslutning
  (singleton `BleManager`, ansluter en gång vid appstart, kopplas aldrig ner
  vid backgrounding) + rå meddelandekodning/avkodning.
- [lib/bleProtocol.ts](lib/bleProtocol.ts) — enda platsen som känner till
  exakt textformat för varje meddelande.
- [context/SessionContext.tsx](context/SessionContext.tsx) — enda platsen
  som matar [lib/sessionMachine.ts](lib/sessionMachine.ts)s reducer från
  lådflödet. Det lådlösa flödet dispatchar manuellt från
  [app/pausing.tsx](app/pausing.tsx).
- [lib/sessionOutbox.ts](lib/sessionOutbox.ts) — beständig lokal kö för
  avslutade lådsessioner, idempotent på `(boxId, seq)`.
- [lib/notifications.ts](lib/notifications.ts) — enda stället som rör
  notis-API:et: den lokala dagspåminnelsen, push-token, Android-kanalerna och
  vad som händer när en push landar eller trycks på. Se notisavsnittet högst
  upp innan något läggs till här.
- [app/pausing.tsx](app/pausing.tsx) — **skärmen nedåt är den lådlösa
  pausens lock.** Klockan går bara medan telefonen ligger nedåtvänd
  (`PHONE_RESTED`); vänds den upp eller lyfts den fryser den
  (`PHONE_LIFTED`) i samma `respite`-fas och samma `pausedMs`-bokföring som
  lådans lock använder. Regeln behöver aldrig skilja på låst skärm och
  appbyte — en nedåtvänd telefon går inte att scrolla i — vilket är tur,
  för `AppState` ger identiska signaler för de två på båda plattformarna.
  Tecknet på `g.z` är spegelvänt mellan iOS och Android, se `isFaceDown` i
  [lib/tilt.ts](lib/tilt.ts). **Lämnas appen räcker inte nedåtvänd — telefonen
  måste också ha stått still** den senaste sekunden (`rotationRate` och
  `acceleration` under `STILL_MAX_*`). Utan det gick det att hålla telefonen
  nedåtvänd i luften, byta app och scrolla medan klockan gick, eftersom
  sensorn tystnar i bakgrunden och lyftet aldrig kom. Trösklarna är
  startvärden; `pause_left_app` loggar topparna så att de kan kalibreras och
  så att det syns om ärliga pauser (en soffa, en säng) fryses av grinden.
  **I bakgrunden får sensorn starta klockan igen bara om telefonen lagt sig
  still** (`appActiveRef`, `assessSettled`, händelsen
  `pause_settled_after_leave`). Sensorn levererar 0,3–1 s efter att appen
  lämnats, och utan villkoret "lades" en telefon som hölls nedåtvänd i
  luften när hemknappen trycktes ner igen 400 ms efter att grinden fryst
  den — sedan tystnade sensorn och klockan gick medan man scrollade. Att
  förbjuda omstarten helt prövades och var fel: samma omstart räddade
  ärliga pauser i testveckan, dels Android-telefoner vars accelerometer
  brusar över grinden på ett bord (0,3–0,6 m/s² vid 0,02°/s), dels telefoner
  som låses i samma rörelse som de läggs ner. Provet läser därför bara
  gyrot, i ett kort fönster (`SETTLE_WINDOW_MS`). **Omstarten gäller bara
  ett kort avbrott:** har klockan stått frusen längre än
  `BACKGROUND_RESTART_MAX_FROZEN_MS` (10 min) startar den bara om appen
  öppnas och telefonen läggs ner igen (händelsen `pause_restart_blocked`).
  Utan taket gick en paus som frös 21:56 igång igen 01:04, när iOS väckte
  appen en stund och telefonen låg på nattduksbordet — natten räknades som
  paus och vännen stod som *pausing now*. Natten undantas: där är omstarten
  efter ett uppvaknande hela poängen. **En beröring medan klockan går fryser
  den** (`freezeOnTouch`, händelsen `pause_touched`), för ett bord rör aldrig
  skärmen, och klockan går igen först när telefonen vänts upp och lagts ner
  på nytt. Systemknapparna ligger utanför appen, så **på Android är
  navigeringsfältet gömt medan klockan går** ([lib/pauseNavBar.ts](lib/pauseNavBar.ts),
  `expo-navigation-bar`), och svepet som tar fram det fryser klockan på samma
  sätt (`source: 'nav_bar'`). Beteendet är `inset-swipe` — med
  `overlay-swipe` visas fältet ovanpå appen utan att appen får veta det.
  Modulen läses valfritt, så en dev-build utan den kör som förut i stället
  för att krascha. Med gestnavigering går hemsvepet troligen igenom direkt
  även med dolt fält; där är det stillhetsgrinden som gäller. iOS
  hemindikator går inte att gömma så att svepet syns för appen.
  Det som återstår är inte vattentätt: lägg
  telefonen nedåt, lås, vänd upp och lås upp så går klockan medan man
  scrollar. Riktig spärr kräver Screen Time (iOS) respektive
  `startLockTask()` (Android) — det är den gränsen lådan finns för.
- [app/placeinbox.tsx](app/placeinbox.tsx) — `standing`/`phonedown`-ritualen
  fram till locket stängs, plus `abandoned` när lådan tystnat (se de tysta
  timeouterna ovan). Lutningsdetektering via [lib/tilt.ts](lib/tilt.ts)
  (gravitationsvektor, inte `rotation.beta/gamma` — se motivering i filen).
  **`phonedown`-vyn måste nämna tummarna** — den är sista skärmen användaren
  kan läsa innan telefonen ligger inne i en stängd låda, och incheckningen är
  en grind som ingen annars vet finns.
  - **Steget går åt båda håll:** reses telefonen upp igen (≥ 45° i 0,5 s) går
    vyn tillbaka till `standing`, för instruktionen ska alltid stämma med var
    telefonen faktiskt är. Glappet mot nedläggningens 8° är hysteresen — utan
    det vippar vyn på mätbrus. Detektorn lever bara medan reducern står i
    `awaiting_lid`: med locket stängt ligger telefonen i en låda som kan
    lyftas och bäras, och lutningen betyder då ingenting.
  - Vändningen skickas till lådan som `phone_up`, som nollar dess
    `phonePlaced` och tar displayen tillbaka till **PLACE PHONE IN BOX**. Det
    är därför fasen, inte meddelandet, som bär innebörden i protokollet:
    `phone_up` betyder "telefonen ligger inte ner" och får olika konsekvens i
    `RESPITE` och `AWAITING_LID`.
  - `awaitLidSinceRef` + `boxSawPhoneDownRef` är appens kopia av lådans
    `phaseStartMs` + `phonePlaced`, och finns för att fristen är ett **ankare,
    inte en omstart**. Firmware kör `setPhase(AWAITING_LID)` bara vid
    `set_mode`, vid ett `phone_down` som ändrar `phonePlaced` från false,
    vid `phone_up` som ändrar den från true, och vid `checking_in` →
    `awaiting_lid`. Appen måste flytta sitt ankare på exakt de tillfällena och
    inga andra: startade den om vid varje vippning kunde skärmen stå kvar
    minuter efter att lådan gått till loggan, och nöjde den sig med ett fast
    ankare skulle den ge upp medan lådan fortfarande väntade.
- [app/_layout.tsx](app/_layout.tsx) — global routing vid återanslutning,
  global `phase === 'ended'` → reset + navigering till `/pausesummary`
  (oavsett monterad skärm), global tillståndsbaserad lyft-detektering
  (`phone_up`) medan en box-session pågår.
- [app/pausesummary.tsx](app/pausesummary.tsx) — tar emot, beslutar
  ingenting. Siffra + mening överst, detaljer (kategori, partnerstatus,
  hjärtat) därunder.

### Användarnamn är unika, skiftlägesokänsligt

`profiles.username` bär ett unikt index på `lower(username)`
(`profiles_username_lower_key`, [supabase/usernames.sql](supabase/usernames.sql)).
Skalet är vikt och inte exakt därför att sökningen är det: `search_profiles`
matchar med `ilike`, så `Maja` och `maja` hade annars kunnat finnas samtidigt
och båda kommit tillbaka på samma sökning — i just de två lägen där man väljer
en människa på namnet (add-friend, circle-invite).

Profilraden skapas av triggern `on_auth_user_created` →
`handle_new_user()`, i **samma transaktion som `auth.users`-raden**. Allt den
kastar sänker alltså hela registreringen, och GoTrue rapporterar den sortens
fel som sitt generiska "Database error saving new user" — en text som inte går
att göra begriplig i efterhand. Därför ger den ett upptaget namn en siffra
(`maja` → `maja2`) i stället för att fela.

**Den siffran är ett skyddsnät, inte flödet.** Tre ställen ska fånga krocken
innan den når dit, och alla tre använder
[lib/username.ts](lib/username.ts) så att formuleringen är en och samma:

- [contexts/AuthContext.tsx](contexts/AuthContext.tsx)s `signUp` frågar
  `username_available` **innan** kontot skapas. `null` från den frågan betyder
  "vet inte" (nätet), inte "upptaget" — då fortsätter registreringen och
  skalet i databasen får avgöra.
- [app/intro.tsx](app/intro.tsx)s `finish()` känner igen `23505` och ber
  användaren trycka på *Name* i kvittot i stället för att visa
  Postgres-texten.
- [app/profile.tsx](app/profile.tsx)s `handleSave` **läser sitt `error`**. Den
  gjorde det inte förut: resultatet kastades bort, skärmen sa "Saved!" och
  `originalName` flyttades fram, så en omdöpning till ett taget namn försvann
  tyst vid nästa inläsning. Ett `.update()` mot `profiles` vars fel inte läses
  är den buggen på nytt.

`username_available` är `security definer` och utdelad till **`anon`** — den
som ska fråga har per definition inget konto än. Den lämnar ut att ett exakt
namn är taget, och ingenting annat: inga rader, inga id:n, ingen lista.

## Statistik — två källor, bara en av dem retroaktiv

**Paustiden har alltid funnits.** `pause_sessions` skrivs från tre ställen
(det lådlösa flödet i [app/pausing.tsx](app/pausing.tsx), lådflödets
[lib/sessionOutbox.ts](lib/sessionOutbox.ts), och krasch-återställningen i
[app/_layout.tsx](app/_layout.tsx)) och har gjort det sedan början. Hur ofta
någon pausar och hur länge går alltså att läsa bakåt i tiden utan att något
behöver byggas — [supabase/analytics.sql](supabase/analytics.sql) är bara
vyer över rader som redan ligger där.

**Funktionsanvändningen hade aldrig någon logg.** Vilka skärmar folk öppnar,
var i introduktionen de hoppar av, hur många försök som faller på en tyst
timeout i lådan — ingenting av det lämnade ett spår. Det är det
[supabase/app_events.sql](supabase/app_events.sql) och
[lib/analytics.ts](lib/analytics.ts) finns för, och **talen börjar på noll
den dag en version med dem är ute.** Det går inte att räkna fram i efterhand,
och ett tomt `app_events` före det datumet är inte en bugg.

Tre regler bär händelseloggen:

- **Vyerna ligger i schemat `analytics` och har inga grants.** De aggregerar
  alla användares rader tvärs över RLS, en vy kör med sin ägares rättigheter
  (`security_invoker` är av som förval), och Supabase delar som förval ut
  select på nya objekt i `public` till `anon` och `authenticated` — en sådan
  vy i `public` vore en publik dump av hela användarbasen. Flytta dem inte
  dit, och grant:a dem inte till `authenticated` "bara för en adminskärm": en
  adminskärm behöver en `security definer`-RPC som kontrollerar *vem* som
  frågar.
- **`app_events` är skriv-bar och inget annat för klienten.** Bara
  `grant insert`, RLS med `user_id = auth.uid()`, ingen update och ingen
  delete. Appen har ingen skärm som läser loggen, och en logg man kan skriva
  om är ingen logg.
- **`track()` får aldrig kasta och aldrig vänta.** Den anropas från
  renderingar, knapptryck och BLE-callbacks. Kön är beständig och skickas i
  batch, och `occurred_at` sätts vid händelsen och inte vid inserten — samma
  skillnad som lådans `ageMs` bär. Raderna saknar `user_id` tills
  `AuthContext` avgjort sessionen och fylls i av `setAnalyticsUser` efteråt;
  de som aldrig får en ägare skickas aldrig.

**Vyerna droppas före sitt `create`, och det är inte slarv.** `create or
replace view` får bara *lägga till* kolumner sist: den vägrar byta datatyp
("cannot change data type of view column") och vägrar skjuta in en kolumn i
mitten — det senare med det förvirrande felet "cannot change name of view
column X to Y", som egentligen betyder att kolumnlistorna hamnat i otakt från
den punkten. Båda är helt normala ändringar i en analysvy, och utan droppen
blir filen omöjlig att köra om. En vy har ingen egen data, så droppen kostar
ingenting. Undantaget är grindarna nedan: de droppas **inte**, eftersom de
andra vyerna hänger på dem, och de behöver det inte heller — de är
`select *` och kan bara växa på slutet.

**Testkonton utesluts, de raderas inte.** `analytics.excluded_users` är
listan, och varje vy läser genom en av grindarna `counted_profiles`,
`counted_sessions` eller `counted_events` — aldrig `public.profiles`,
`public.pause_sessions` eller `public.app_events` direkt. En ny vy som
glömmer grinden räknar testkontona igen, och ingenting felar. Listan bor i
`analytics` och inte som en kolumn på `profiles`: appen ska inte kunna läsa
vilka konton som är testkonton, och "räknas inte i statistiken" är ett
påstående om analysen snarare än om användaren. Tabellen har medvetet ingen
främmande nyckel mot `auth.users` — raderas ett testkonto på riktigt nollas
`app_events.user_id` i stället för att försiktigt försvinna, och
uteslutningen måste överleva kontot. Frågorna för att hitta och utesluta dem
står i [supabase/analytics-queries.sql](supabase/analytics-queries.sql),
avsnitt 10.

**Skärmvisningarna räknas på ett enda ställe** — rutt-lyssnaren på
`usePathname()` i [app/_layout.tsx](app/_layout.tsx). Varje skärm hade kunnat
ropa själv, men då saknar varje ny skärm sin rad tills någon kommer ihåg
anropet. Lägg inte till ett `screen_view` i en skärm.

**Ingen text, aldrig.** Chattmeddelanden och stödsvar loggas med sin *längd*,
inte sitt innehåll: `circle_messages` och `support_responses` äger orden, och
en kopia i `app_events` hade gjort en raderad rad till en rad som finns kvar
någon annanstans. Samma linje som att chatten inte dubbleras i
`circle_activity`.

**Händelseloggen är ingen notiskanal.** Den skickar rader till en tabell som
bara SQL-editorn läser. Appens notiser (se högst upp) har sina egna
källor — dagspåminnelsen räknas ur `get_daily_goal_progress`, kretsens
dagsmål ur `circle_pause_ledger`, de sociala ur sina egna inserts — och ingen
av dem rör någonting i den här
filen. En händelse i `app_events` som fyrade en notis vore en helt annan
sorts funktion med helt andra avvägningar.

Städningen (`analytics.prune_app_events(days)`) körs för hand — det finns
ingen cron i projektet, samma linje som `evaluate_circle_goals()`. Händelser
växer snabbare än allt annat i databasen; en aktiv användare lägger lätt
hundra rader om dagen bara i skärmvisningar.

> **Obs:** lådläget är avstängt i appen idag (`POD_COMING_SOON` i
> [app/pause.tsx](app/pause.tsx)), så `box_*`-händelserna och
> lådgrenen av `analytics.pause_funnel` står tomma tills den konstanten
> sätts till `false`. Vyerna är ändå på plats — de ska finnas den dagen
> lådan går att välja, inte byggas då.

## Stödsvaren — fyra medier, två kanaler

**Ordet användaren ser är *support*, inte *pep*.** Funktionen hette "pep
message" på varje yta, och det var fel av två skäl. Det ena är att `pepp` är
svenska som smugit in i engelsk text (`PEPP` stod bokstavligen som rubrik i
[app/support-view-text.tsx](app/support-view-text.tsx)). Det andra är allvarligare:
`pepp: 'Pep'` är redan **en av de 24 tonerna** man kan be om, mellan
`Laughter` och `Cheering` — alltså samma ord för helheten och för en del av
den, precis den otydlighet som gjorde att Community blev Friends.

Tabell-, kolumn- och filnamn behåller `support_*` som förut; bara de strängar
användaren läser ändrades, samma linje som `Palette.community` och
aktivitetstypen `weekly_goal_updated` fick behålla sina namn. Formuleringarna
är **`Support for <namn>`** på de fyra svarsskärmarna (formatordet föll bort —
en skärm som *är* en kamera behöver inte heta "Photo"), **`Support from
<namn>`** / `SUPPORT FROM` / `SUPPORT` på de inkommande, och
`Write a few words of support to <namn>…` i textfältet.

**En känd skavank, vald och inte förbisedd:** `stöd: 'Support'` är också en av
de 24 tonerna, så kollisionen är inte helt borta — den är flyttad till ett ord
som i engelska är brett nog att bära båda betydelserna, och som redan är
domänens ord i hela kodbasen. `pepp: 'Pep'` och `motivationstal: 'Pep talk'`
står kvar som toner, för där är de idiomatisk engelska och krockar inte längre
med något funktionsnamn.

Ett svar på en stöd-story kan vara **text, röst, video eller foto**. De fyra
ligger som fyra piller i story-läsaren ([app/(tabs)/friends.tsx](app/(tabs)/friends.tsx)),
och raden har `flexWrap` sedan den fjärde kom till: fyra piller med etikett
ryms inte bredvid varandra på en iPhone SE, och en krympt etikett är samma fel
som typskalans golv finns för att hindra.

**Men inkorgen har bara två knappar, och ska ha det.** Luren är det som
ringer (röst och video, via [app/call.tsx](app/call.tsx)); kuvertet är det som
bara ligger där (text och foto, via `handleQuietChannel`). En tredje ikon på
rubrikraden hade gjort den till en verktygslåda — samma skäl som kretsens
rubrikrad inte fick en tredje. Kuvertet är fortfarande ett kuvert: det är vad
man öppnar, inte vad som ligger i.

- `call.tsx` filtrerar numera på `response_type in ('voice','video')`. Frågan
  tog förut det äldsta oöppnade svaret av vilken sort som helst, trots att
  luren bara öppnas när det finns röst eller video — ett äldre textsvar kunde
  alltså ringa som ett samtal. Med fotot blev det värre: `photo` finns inte i
  ternären som sätter underrubriken och hade fallit igenom till "video".
- Både text och foto slutar med samma två val (*I'll take a pause* /
  *Not a good time*). Det är samma sorts pepp som landat på två sätt.

**Bildtexten brinner aldrig in i fotot.** Bilden går till bucketen
`support-media` som `content_url`, bildtexten ligger i `text_content` — samma
kolumn som textsvaret redan använder — och de två slås ihop först när bilden
visas. Det är inte en genväg utan den enda vägen: att platta ihop dem till en
ny JPEG kräver `react-native-view-shot`, alltså en native-modul och en ny
dev-build, samma skäl som [components/progress-ring.tsx](components/progress-ring.tsx)
ritas för hand. Följden är dessutom bättre än alternativet — texten skalar med
mottagarens skärm och kan aldrig bli en suddig inbränd rad.

- **Priset är `support_responses.caption_y`**
  ([supabase/support_photo.sql](supabase/support_photo.sql), körs för hand i
  SQL-editorn som resten av mappen). Bildtexten dras upp och ner över bilden
  när den skrivs, och var den hamnade är en del av meddelandet: en rad över en
  hand betyder inte samma sak som en rad under en himmel. Talet är en **andel**
  (0–1) av bildytans höjd och inte en pixel — ytan är hela skärmen hos både
  avsändaren och mottagaren, och de två skärmarna är sällan lika höga.
- **Allt som styr hur raden ser ut bor i [lib/photoCaption.ts](lib/photoCaption.ts)**,
  importerat av båda skärmarna. Två kopior av de talen hade inte bara glidit
  isär i koden utan i *meddelandet* — avsändaren ser raden på ett ställe och
  mottagaren får den på ett annat. Samma skäl som `duration-wheel.tsx` finns
  för, med en skarpare följd. `resizeMode="cover"` hör till samma lista: byter
  den ena skärmen måste den andra byta likadant.
- Bandet är en tonad svart remsa med vit text, och remsan är inte dekoration:
  utan den försvinner vit text i en vit himmel, och bilden är någon annans.
- `response_type` får ett fjärde värde. Vilken check-constraint som sitter på
  kolumnen står ingenstans i repot (tabellen skapades utanför det, som
  `support_stories`), så SQL-filen **letar upp** den i stället för att gissa.

**`uploadViaXhr` bor numera i [lib/supportMedia.ts](lib/supportMedia.ts).** Den
låg som en byte-identisk kopia i röst- och videoskärmen, och fotot hade gjort
den till tre — med bucket-namnet och Supabase-URL:en på tre ställen. XHR och
`FormData` och inte `supabase.storage.upload()`: klienten vill ha en Blob, och
React Natives `fetch` mot en `file://`-URI ger en tom sådan på Android.

## Design

Ljusblå accent (`#2e86de`) på plommonbotten. Bottnen var marinblå och är det
inte längre — se *Plommon, rum och bakgrunden* nedan — men accenten är samma
tal som förut, och den är det enda som är gemensamt för alla tre flikarna.

**Grönt (`#27ae60` appen / lådans `GREEN`-ton) används bara på lådan** — dess
enda bekräftelsefärg (checkmark i startceremonin). Använd inte grönt i appen som
**bekräftelse** — det är den betydelsen som hör lådan till. Tre undantag, och
alla tre är just undantag från betydelsen snarare än från kulören: svara-knappen
i ett inkommande samtal (`Palette.callAccept`), där grönt betyder "svara", de
två nedersta nivåmärkena i Kretsens stege (`peer`, `slideAccent.green`), där
grönt är början på ett färgspektrum och står för *grodd*, inte för klart, och
**Kretsflikens rum** (`hue` `#6cc99a` mörkt / `#23845a` ljust), där grönt är
*vilket rum man står i*. Det tredje är det största och därför värt att säga
rakt ut: en hel flik är grön nu, och inget av det grönet betyder att något
gått vägen. Bekräftelse är fortfarande lådans, och den gröna fliken bekräftar
ingenting — den är en vägg, inte ett kvitto.
**Ett fjärde undantag bryter faktiskt mot betydelsen, och det är valt på
begäran:** en medlem som nått sitt mål visas i Kretsens *See everyone* som
`14h 10min / 6h ✓` i rummets `hue`. Det grönet *betyder* att något gått vägen.
Det är rummets egen kulör och inte lådans `GREEN`, och det står bara i den
raden — men det är en bekräftelse, och nästa gröna bekräftelse ska prövas mot
den här och inte glida in för att den här finns.
**Ett femte undantag, också på begäran:** `+6 min won back` överst i
taggkortet efter en paus står i `Palette.success`. Det grönet säger att man
vunnit något — en bekräftelse, alltså samma sort som det fjärde. Det gäller
bara den raden; svaret på ett val (`REWARD_LINES`) och konfettin är
fortfarande utan grönt.
**Ett sjätte undantag, på begäran:** intentionerna **READING** (mjukt grön,
åt gult) och **NATURE** (grön) har gröna toner (`INTENTION_TONES` i
[components/pause-tag-chips.tsx](components/pause-tag-chips.tsx)). Där är
grönt en *kategori* — skog och blad — och betyder inte att något gått vägen,
samma sorts undantag som Kretsens stege.
Ett nytt grönt någon annanstans ska förklaras på samma sätt eller inte finnas.
Arial Black-liknande versaler (`fontWeight: '900'` + versaler) för
displaytext, vanlig vikt för brödtext. Instruktioner på tre till fyra ord,
inte meningar.

### Flikarna heter Pause, Circle och Friends

Tredje fliken hette **Community** och heter sedan en rapport om att ingen
förstod skillnaden mot **Circle** i stället `Friends`. Båda orden var
abstrakta gruppord — i vanligt språk *är* en circle en community — och inget
av dem sa vad man gör på ytan. `Friends` ger paret en asymmetri som går att
hålla i huvudet: **en grupp** mot **enskilda personer**. Fliken *är* vänlistan,
förfrågningarna, wrapped och pep-inkorgen.

`Palette.community` behöll sitt namn, och har gjort det genom två kulörbyten.
Nyckeln är en *kulör* och inte en rubrik: den var lilan i stödförfrågningarna
och är sedan Friends-rummet blev varmt en kakaobrun (`#bf8469` mörkt /
`#80522f` ljust). Ett namnbyte hade rört varenda story-yta utan att någon läst
något nytt — och eftersom namnet är funktionen och inte färgen håller det
även när färgen byts.

**Kretsens flikikon är en ring (`circle`, kontur) — inte `people-circle-outline`.**
De två flikarna bar förr var sin klump av människor, och vid 20 punkter är det
samma bild — flikraden är det enda stället i appen där de två orden står intill
varandra, och där hjälpte ikonerna inte till. Den var en tid `layer-group`
(stegen) och blev en ring på begäran: ringen är ordet självt och formen hela
ytan är byggd av. Kretsens tomvy använder fortfarande `layer-group`.

**`circle` blev inte `group`.** Frågan ställdes och svaret var nej: *group* är
ett vagare ord, inte ett tydligare, och saknar det *circle* har — en form, som
hela ytan är byggd av (heroringen, dagsringen, nivåmärkets skivor,
progressringen). Två rader säger ändå fortfarande *group* — `Open group
members` i [app/(tabs)/circle.tsx](app/(tabs)/circle.tsx) och `Create a small
group with friends…` i dess tomvy. Att samma sak har två namn är samma sorts
otydlighet som den rapporterade, bara inne i en flik, och de bör säga
*circle*.

### Insikten är borttagen

**Veckans *insight* finns inte längre.** Den var en rad på 140 tecken som man
skrev i ett bottenark bakom nordstjärnan uppe i Friends-fliken (eller på en
egen sida i sin egen wrapped), och som sedan dök upp som en extra sida i
vännernas weekly summary. Den revs för att ingen använde den. Det som
försvann:

- Stjärnknappen i Friends-flikens rubrikrad och hela `insight`-modalen bakom
  den, plus den `titleRow` som bara fanns för att hålla ihop logotypen med
  knappen ([app/(tabs)/friends.tsx](app/(tabs)/friends.tsx)).
- `InsightSlide` och dess sida i [app/my-wrapped.tsx](app/my-wrapped.tsx) —
  det var skrivytans andra hälft, och en wrapped som går att redigera var
  hela skälet att den sidan hade ett `isInsightSlide`-undantag i sin
  annars rena `PageConfig`-lista. Listan är rena render-callbacks igen.
- Visningssidan i [app/friend-wrapped.tsx](app/friend-wrapped.tsx). Den var
  villkorlig (`makeBasePages` + `makeInsightPage` när vännen hade skrivit
  något), vilket är varför sidlistan nu bara heter `makePages` och byggs i
  ett led.

**Kolumnen `profiles.weekly_insight` står kvar** — oläst och oskriven, samma
linje som `push_token` och `circle_members.daily_target_seconds`: kolumner
droppas inte i `supabase/`-mappen. Gammal text ligger alltså kvar i basen men
syns ingenstans. Vill man ha funktionen tillbaka är den en ny funktion, och
frågan att svara på först är varför den ska finnas när den inte användes —
inte hur den såg ut.

### Botteninsetet har ett golv på Android

Flikraden i [app/(tabs)/_layout.tsx](app/(tabs)/_layout.tsx) räknar sin
underkant som `Math.max(insets.bottom, 24)` på Android, inte som
`insets.bottom` rakt av. Samsung-användare rapporterade att systemets egna
knappar låg ovanpå raden: på en del Android-skal kommer insetet tillbaka som
0 eller några få punkter trots att navigeringsfältet eller gest-strecket
faktiskt ritas där. Golvet ger raden något att stå på, och på en telefon som
rapporterar rätt (48 för tre knappar) ändrar `Math.max` ingenting. iOS får
inget golv — där stämmer insetet.

Ovanpå det ligger `TAB_LIFT` (10), som växer **både** höjden och
`paddingBottom`. Att bara öka paddningen hade krympt ytan mellan
paddningarna och tryckt ihop ikon och etikett; nu står de 44 punkter höga
som förut, bara högre upp.

**Golvet bor i [lib/bottomInset.ts](lib/bottomInset.ts)** (`safeBottom()`),
och fler skärmar än flikraden läser det: kretsens wrapped (prickarna låg
under Samsungs tre knappar med en fast `paddingBottom: 44`) och kretsens
meny. Övriga skärmar (`circle-chat`s skrivrad, `circle-invite`s fot) läser
fortfarande `insets.bottom` rakt av. Dyker samma rapport upp för dem är det
det här golvet som ska återanvändas, inte ett nytt tal per skärm.

### Grå text har ett kontrastgolv, inte bara en storlek

`textTertiary` låg på 0.40 (mörkt) / 0.48 (ljust) och gav **3.4:1** mot den
ljusaste ytan i appen — under AA, och rapporterat som text som "försvinner lite
i bakgrunden". Den står nu på **0.52 / 0.68**, de första stegen som klarar
4.5:1 överallt. Sätt den inte tillbaka.

**Starkare bläck är inte samma sak som mörkare.** I mörkt läge betyder
"tydligare" *ljusare*, och i ljust läge *mörkare* — det är alfan som ökar i
båda fallen, åt motsatta håll i RGB. En begäran om "mörkare grå text" i mörkt
läge menar alltid det förra.

**Den akuta boven var dock inte skalan utan vem som läste ur den.**
[components/pause-activity-chart.tsx](components/pause-activity-chart.tsx)
hämtade veckodagarna (`M T W T F S S`, `axisText`) ur `ink28` och måtten ur
`ink22`/`ink25` — alltså de steg som enligt ink-skalans egen regel är *ytor och
hårstreck*, använda som text. `ink28` ger 2.4:1. De ligger nu på
`ink50`–`ink60`, och av- och på-lägena flyttades tillsammans så att de
fortfarande går att skilja på.

**Regeln som följer:** text läser ur `textPrimary`/`textSecondary`/
`textTertiary` eller ur ett ink-steg **över 0.30**. Under 0.30 är stegen till
för kanter och ytor, och en etikett som hamnar där försvinner — oavsett hur
stor den är. Enda kvarvarande luckan är `textTertiary` på `modalSurface` i
mörkt läge (4.18:1, alltså AA bara för stor text); tertiärtext på modaler är
tidsstämplar och bildtexter, och att höja alfan ytterligare hade gjort
`textTertiary` och `textSecondary` till samma ton.

### Typskalans golv är 11

**Ingenting i appen är mindre än 11px.** Skalan höjdes efter att en äldre
användare sa att den minsta texten inte gick att läsa, och de minsta stegen
fick mest: 9 → 11 och 10 → 12, medan 11/12/13 bara flyttades ett snäpp till
12/13/14. 14 och uppåt rördes inte — de var aldrig problemet, och att flytta
dem hade tryckt om knappar och rader utan att någon läste bättre. `lineHeight`
följer alltid med sin `fontSize` lika många punkter; annars blir raderna
trängre ju större texten blir.

**Telefonens textstorlek förstorar högst 1,3 gånger** (`MAX_FONT_SCALE` i
[lib/fontScaleCap.ts](lib/fontScaleCap.ts)). Med textstorleken uppskruvad
flöt allt ut — iOS tillgänglighetsstorlekar går till ~3,1×, och brickor,
ringen och korten är byggda för text som växer lite. 1,3 är Androids största
vanliga steg och strax under iOS största före tillgänglighetsstorlekarna.
Taket sätts genom att React Natives `Text`- och `TextInput`-moduler byts mot
ett omslag, eftersom React 19 inte läser `defaultProps` på
funktionskomponenter. Det laddas från appens egen startfil
[index.js](index.js) före expo-router — **`main` i package.json måste peka
dit**, annars försvinner taket tyst. Ett eget `maxFontSizeMultiplier` på en
text vinner alltid.

Sätter man 9 eller 10 någonstans igen är det en regression, inte en nyans.
Tre brickor (`tabBarBadgeStyle`, `inboxBadge`, `sectionBadge`) har fast höjd
och fick växa med sin text — en siffra som inte får plats i sin cirkel är den
andra sidan av samma bugg.

### Ord som inte bär något tas bort

Etiketter upprepar inte vad sammanhanget redan sagt. Ringen på Hem *är*
dagsmålet, så `of 30 min` behöver inget `today`; stegen i Kretsen är
kretsens, så livstidssumman behöver inget `together`. Undantaget är potten i
veckopanelen, som står direkt under heron där samma sorts siffra visar *din*
vecka — där är `together` det enda ordet som skiljer de två åt, och det
stannar.

Raden `N/M TO GO` i veckopanelen är borttagen av samma skäl: den gick bara
att förstå genom att fälla ut listan ändå, och listan säger det bättre.
`N OF M GOALS SET` står kvar, för den rapporterar ett *annat* läge — att
målen inte ens är satta, vilket är varför potten är ofullständig och stapeln
dämpad. Utan den raden ser det tillståndet ut som en bugg i stället för ett
tomrum någon kan fylla.

### Två lägen, en palett

[constants/appTheme.ts](constants/appTheme.ts) exporterar `darkPalette` och
`lightPalette` med **identiska nycklar**. Accenten är samma `#2e86de` i båda —
det är bakgrunden som vänder, inte appens färg. Väljaren sitter i
[app/onboarding.tsx](app/onboarding.tsx) (skärmen heter *Settings* trots
filnamnet) och sparas per enhet i AsyncStorage av
[contexts/ThemeContext.tsx](contexts/ThemeContext.tsx), inte i `profiles`:
utseendet följer skärmen man tittar på och ska gälla redan innan någon loggat
in. `'system'` är ett val om var läget kommer ifrån, inte ett tredje utseende.

**Varje skärm bygger sina stilar av paletten, inte av en konstant:**

```tsx
export default function NågonSkärm() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  ...
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({ ... });
```

Parametern heter `Palette` med flit — den skuggar allt som förr importerades
under samma namn, så `Palette.accent` betyder samma sak ute i JSX som inne i
stilarna. `StyleSheet.create` fryser sina värden när modulen laddas, så en
palett som muteras vid lägesbyte skulle inte nå fram: `makeStyles` är inte
prydnad utan hela mekanismen. `Palette.eyebrow` och `Palette.cardShadow` bor
därför också på paletten.

Tre saker att inte gå vilse på:

- **Ink-skalan (`Palette.ink04` … `ink90`)** ersätter alla handskrivna
  `rgba(255,255,255,a)`. Alfavärdena är inte speglade rakt av: under ~0.30 är
  nivåerna ytor och hårstreck, och svart bläck biter hårdare på vitt än vitt
  gör på svart, så de tonas ned i ljusläget. Över ~0.30 är de text och följer
  med rakare. Skalan måste vara stigande i båda lägena — ett steg som inte är
  mörkare än steget under är en bugg, inte en nyans.
- **`Palette.textPrimary` och `Palette.onAccent` är inte samma vita.**
  `textPrimary` är brödtext och vänder med läget; `onAccent` är text och
  ikoner ovanpå en fylld blå (eller röd, eller lila) yta och är vit i båda
  lägena, eftersom ytan under den aldrig byter ton. Att blanda ihop dem ger
  osynlig knapptext i det ena läget.
- **`alpha(Palette.community, 0.15)`** i stället för en nedskriven rgba: tonen
  ska följa med när grundfärgen byter läge.

[app/video.tsx](app/video.tsx) och
[app/support-respond-video.tsx](app/support-respond-video.tsx) är undantagna
och har kvar sina svarta och vita literaler. Där är kamerabilden bakgrunden,
inte en yta appen målar, och ett ljust tema hade gett vit text på video.
`components/themed-text.tsx`, `components/ui/collapsible.tsx` och
`app/modal.tsx` är kvarlämnad Expo-mall som inget i appen leder till; de kör
fortfarande `constants/theme.ts` och rördes inte.

### Plommon, rum och bakgrunden

De två paletterna heter **Plommon härd** (mörkt) och **Plommon papper**
(ljust), och de är ett *par* snarare än två teman: mörklägets bläck är
ljuslägets papper (gräddvitt `rgba(255,244,236,a)`), och ljuslägets bläck är
plommonbrunt `rgba(42,31,40,a)`. Ink-skalan är alltså inte längre kulörlös, och
det är avsiktligt — ett grått hårstreck på en plommonbotten ser ut som smuts.

**Accenten är oförändrad: `#2e86de` i båda lägena.** Det är bottnen som bytte
kulör, inte appens färg. `Palette.shadow` är däremot inte längre accenten:
den var en blå glöd under varje kort i mörkt läge, och mot plommon blev det en
andra kulör i stället för ett lyft.

**Varje flik har ett *rum*.** Ett rum byter fem nycklar — `hue`, `bg`,
`surface`, `surfaceAlt` och `sunken` — och tabellen står i `ROOMS` i
[constants/appTheme.ts](constants/appTheme.ts): Pause blå, Circle grön,
Friends varm terrakotta. `hue` är det som säger var man står (logotypen, `eyebrow`, den
aktiva flikikonen, tonade ytor, förloppsstaplarna), och `hueTint` är samma
kulör som yta (0.16 mörkt / 0.13 ljust — asymmetriskt av samma skäl som
ink-skalan är det).

- **Listan var tre nycklar och det var för få.** `surfaceAlt` och `sunken`
  låg kvar i basens plommon, och eftersom basens `surfaceAlt` är `#2f2630`
  mörkt och `#f1e8e6` ljust — en ljusbrun — satt den som **varma fläckar
  mitt i ett blått, grönt eller varmt rum**: temaväljaren och kategoripillren
  i Settings, `declineBtn` och avatarernas reservyta i Kretsen, en ram i
  Friends. Det rapporterades som "ljusbruna färgkoder i botten" och det var
  exakt vad det var.
- **Lutningsordningen måste följa basens, och den är inte samma i de två
  lägena.** Mörkt: `sunken < bg < surface < surfaceAlt` — den sekundära ytan
  är *ljusast*. Ljust: `sunken < surfaceAlt < bg < surface` — där är rent
  vitt högst och `surfaceAlt` en indragen ton *under* botten. Bryts ordningen
  i ett rum ser det ut som att två ytor bytt plats, och ingen typkontroll
  fångar det.
- **Lägger någon till en sjätte ytnyckel ska den in i `RoomTokens`** om den
  någonsin målar en bakgrund. Regeln att gå efter: en nyckel som är en *yta*
  hör till rummet, en nyckel som är en *roll* (`accent`, `community`,
  `peer`, `danger`, `highlight`) gör det inte. `modalSurface` är det
  avsiktliga undantaget — se modalstycket nedan.

**Ett rum är inte samma sak som en flik, och `study` är beviset.** Det fjärde
rummet har ingen flik: det bär statistiken ([app/stats.tsx](app/stats.tsx)),
Settings ([app/onboarding.tsx](app/onboarding.tsx)) och profilen
([app/profile.tsx](app/profile.tsx)) — de tre som nås från ikonerna i Hems
topbar. Dess `hue` är **identisk** med `pause`, för det är hue som säger
vilken färg rummet har, men `bg` och `surface` är mörkare. Man ska känna att
man gått en trappa djupare in i det blå rummet, inte att man bytt hus. Rummet
följer alltså *ärendet* och inte filträdet: `app/pause.tsx` ligger också
utanför `app/(tabs)/` och hör till `pause`, eftersom den är PAUSE-knappen
fortsatt ett steg.

- **Accenten byter aldrig rum, och det är hela mekaniken.** Det som är *ifyllt*
  är `#2e86de` i vartenda rum: PAUSE-knappen, CHECK IN, brickorna, dagsringen
  och de fyllda knapparna. Rummet är väggarna, accenten är möblerna, och det
  är den skillnaden som gör att fyra olikfärgade ytor läser som samma app.
  - **Men de fyrkantiga ikonknapparna gör det inte längre**, och det är en
    medveten ändring på begäran snarare än ett undantag som smugit sig in.
    Kretsens chatt- och veckoknapp, dess chevroner och `user-plus`, samt
    Friends lur och kuvert bär numera `hue` i ikon och ram — alltså
    ljusgrönt respektive terrakotta. Skälet är att de **sitter i rummets egen
    rubrikrad**: en blå ikon i en grön rubrik läste som att den hörde till
    något annat. Knappytan under dem är fortfarande `surface`, så det är
    teckningen som bytt kulör, inte fyllningen — gränsen går alltså numera
    vid *fylld yta*, inte vid *knapp*.
  Därför är `hue` en egen nyckel och inte en omskrivning av `accent`: hade
  rummen patchat accenten vore det enda gemensamma borta.
- **Rummet är en provider, inte ett argument.** `RoomProvider` i
  [contexts/ThemeContext.tsx](contexts/ThemeContext.tsx) gör att `usePalette()`
  svarar med rummets palett utan att anropsstället vet om det.
  `usePalette(room)` hade inte gått: `circle.tsx` och `friends.tsx` har ett
  tiotal egna komponenter var på modulnivå som anropar `usePalette()` själva,
  och ett argument hade missat varenda en av dem.
- **`roomPalette()` cachar per `mode:room`, och cachen är ett krav och inte en
  optimering** — varje skärm bygger sin StyleSheet med `useMemo` på paletten,
  så ett nytt palettobjekt per render hade byggt om varenda StyleSheet i appen
  vid varje omrendering. Samma skäl som `value` i ThemeContext är memoiserad.
- **Skärmen ligger i ett skal, och bakgrunden bor i skalet.** Mönstret är
  `HomeRoom` → `RoomProvider` → `roomShell` → `<ScreenBackground>` +
  `HomeScreen`. Två skäl: en komponent kan inte läsa sin egen provider, och en
  bakgrund i skalet täcker **varje** gren skärmen kan returnera — laddning,
  tomvy, innehåll — utan att någon av dem behöver minnas att rita den.
  Skärmarnas `container` är därför `'transparent'`; en färg där hade lagt sig
  ovanpå lagren.
- **Flikraden kan inte ligga i någon provider** (den står kvar medan flikarna
  byts), så den läser rummet ur rutten i stället. Raden ritas numera av appen,
  [components/room-tab-bar.tsx](components/room-tab-bar.tsx), och läser rummet
  ur den aktiva ruttens namn (`ROOM_BY_ROUTE`); layouten behåller
  `ROOM_BY_PATH` för botten bakom scenerna. Raden tar rummets `bg` och den
  aktiva ikonen dess `hue`, och en **markering i rummets kulör glider** bakom
  den aktiva fliken (500 ms) medan botten tonar över till nästa rum. Ikoner,
  etiketter och brickor läses fortfarande ur varje skärms `options`;
  brickorna är ifyllda och stannar i accenten.
- **Flikbytet glider och tonar:** den nya sidan kommer 28 px från sitt håll
  och tonar upp på 500 ms (`TAB_TRANSITION` i layouten, native-drivern). Med
  reducerad rörelse används ingen övergång. En botten i rummets `bg` ligger
  bakom scenerna, för mitt i övertoningen är båda sidorna halvgenomskinliga.

**Friends är det enda varma rummet, och det enda som äger sitt eget ljus.**
Rummet var lila och är mjuk terrakotta (`#e8a87c` mörkt / `#9d5520` ljust) på
varmbrun botten. Det ligger närmare basens "Plommon härd" än lilan gjorde —
bläcket *är* gräddvitt, och grädde på varmbrunt är parets egen logik — och
eftersom de tre andra rummen är svala får Friends en egen **temperatur** och
inte bara en egen kulör. Det är den tydligaste skillnad en flik kan ha.

- **Glöden och vinjetten går att skriva över per rum, och Friends är det enda
  som gör det** (`ROOM_GLOW_1`, `ROOM_GLOW_2`, `ROOM_VIGNETTE` i
  [components/screen-background.tsx](components/screen-background.tsx)). Det
  delade ljuset är blått, och blått ljus på varmbrun botten är
  komplementfärger: de blandar mot **grått**, så glöden hade grånat precis den
  botten den skulle lyfta. Tabellerna innehåller bara de rum som avviker, och
  allt annat faller tillbaka på förvalet — de svala rummen är oförändrade till
  sista decimalen.
- Ljuslägets vinjettkant är varmbrun (`rgb(80,50,30)`) i stället för plommon
  av samma skäl: en sval kant runt en varm botten läser som en smutsrand och
  inte som en skugga.
- **Stödets kulör följde med in i värmen.** `Palette.community` var lila och
  är kakaobrun (`#bf8469` / `#80522f`): plusset, story-ringarna, pillren för
  svarsformat och deras tryckytor. Den följer *funktionen* ut till
  support-skärmarna utanför fliken, så bytet nådde dem också — vilket är
  meningen, för stödflödet börjar här.
  - Den är **brunare och mörkare än rummets `hue`** (dE ≈ 16 mörkt, ≈ 18
    ljust) så att en story-ring har en egen kant mot en terrakotta
    sektionsrubrik. Det gamla lila paret behövde ingen sådan marginal — i
    ljust läge var `community` och rummets hue *samma* `#6c5ce7` — men två
    bruna toner intill varandra smälter ihop på ett sätt två lila inte gjorde.
  - **`Palette.peer` är kvar grön**, och det är avsiktligt: den är hela
    skillnaden mellan *din egen* story och *andras*. Två varma toner för den
    skillnaden hade varit svårare att se än en varm och en grön, och den
    gröna står under grönregelns undantag på samma grund som Kretsens stege.

**En modal tillhör rummet man öppnade den från.** `Palette.modalSurface` är
därför en av rummets nycklar, och `Palette.modalBorder` härleds ur `hue` — så
en sheet i Friends är varm, en i Kretsen grön och en på Hem blå, utan att någon
skärm vet om det.

- **Det var en enda blå för hela appen, och den regeln föll.** Motiveringen var
  att en modal är ett lager *framför* rummet och inte en del av det. Det höll
  så länge varje rum var svalt. Sedan Friends blev varmt hade "Ask for
  support"-arket tre temperaturer i samma bild — blå sheet, bruna valrader,
  varmbrunt rum bakom — och stödets egen kulör tappade kontrast mot sheeten
  (3.78:1). Det som bar den gamla motiveringen bärs ändå redan av
  `Palette.scrim`: **det är mörkningen bakom kortet som säger "det här ligger
  framför", inte kulören.**
- **Kvar av regeln är måttet, inte kulören.** Modalytan är alltid *ljusare* än
  sitt eget rums `bg` och, i mörkt läge, även än dess `surfaceAlt` — en modal
  i samma ton som sidan under ser ut som en del av sidan. Lägger man till ett
  rum måste dess `modalSurface` klara samma test.
- Alla tolv modalkort i appen pekar på den (fyra i Kretsen genom en delad
  `card`, fem i Friends, två på Hem, och en var i Settings, valskärmen,
  profilen och statistiken). `surfaceAlt` är kvar för det som *inte* är en
  modal — temaväljaren och kategoripillren i Settings, `declineBtn` och
  avatarernas reservyta.
- I ljust läge är lyftet litet i sig (1.1:1 mot rumsbotten) — där gör scrimen
  den tunga separationen och modalytan ser till att kortet ändå är det ljusaste
  i bilden.
- `modalBorder` är `alpha(hue, 0.22 mörkt / 0.16 ljust)` och beräknas i
  `derive()`, inte skriven per rum. Därför kan ett nytt rum inte glömma den.
  **Det är också skälet att `alpha()` står ovanför `derive()` i filen:**
  `derive` körs vid modulladdning, och en `const`-pil som deklarerats längre
  ner hade gett ReferenceError i TDZ.

**Rummet följer ärendet, inte filträdet.** Tjugo skärmar ligger i ett rum, och
bara tre av dem är flikar. Resten ärver rummet från vad de *handlar om*:

| Rum | Skärmar utöver fliken |
|---|---|
| `pause` | `pause`, `placeinbox`, `pausesummary` |
| `circle` | `circle-chat`, `circle-create`, `circle-invite`, `circle-welcome` |
| `friends` | `add-friend`, `support-story-create`, `support-view-text`, `support-respond-text`, `support-respond-voice`, `text-message`, `call`, `voice` |
| `study` | `stats`, `onboarding` (Settings), `profile` — ingen flik alls |
| `night` | `pausing` — ingen flik, och **mörkt i båda lägena** |

**`night` är det enda rummet som inte byter läge.** Det bär pausen medan den
pågår, och natten är poängen. `roomMode()` svarar därför `dark` för det oavsett
val, i både `roomPalette` och bakgrunden — annars hamnar ljuslägets bruna bläck
på marinblått. Statusraden tvingas ljus på skärmen av samma skäl.

**Fem sorters skärmar står med flit utanför, och skälen är olika:**

- **De tre wrapped-sidorna** (`my-wrapped`, `friend-wrapped`,
  `circle-wrapped`) målar en egen `slideAccent` per sida. En rumsbotten hade
  aldrig synts, och rummets `hue` hade slagits med sidans egen kulör.
- **Kameraskärmarna** (`video`, `support-respond-video`,
  `support-respond-photo`) och fotovisaren (`support-view-photo`): där *är*
  bilden bakgrunden. Samma undantag som redan står under *Två lägen, en palett*.
- **Introduktionen** (`app/intro.tsx`): den körs innan man vet att flikarna finns,
  så det finns inget rum att ärva.
- **Inloggningen** (`app/auth/`): samma sak, och dessutom inget konto än.
- **`app/modal.tsx`**: kvarlämnad Expo-mall som inget i appen leder till.

**[components/screen-background.tsx](components/screen-background.tsx) är fyra
lager underifrån: rummets bg, en skymningshimmel, två mjuka glöd, och en
vinjett.** Bottnen är en vanlig `backgroundColor`; de tre toningarna ligger i
ett enda `Svg` ovanpå den, och vinjetten ritas sist eftersom den ska mörkna
allt under sig.

- **Det här var appens första `react-native-svg`, och skälet biblioteket
  finns.** Regeln det bryter mot stod i progress-ring och nivåmärkena: ingen
  native-modul för ett enda element. Undantaget är att det här inte *är* ett
  element — det är botten i alla tre flikarna, och tre av lagren är toningar,
  som inte går att rita för hand utan att banda. Formerna ritas fortfarande
  för hand, och ska fortsätta göra det. Den andra användaren är vågytan i
  [components/liquid-bars.tsx](components/liquid-bars.tsx): en kurva, alltså
  inte heller en form av kanter — och svg:n är statisk där, allt som rör sig
  är transformer på View-ar. Biblioteket kräver en ny dev-build;
  `npx expo install react-native-svg` räcker inte för en telefon som redan har
  en gammal.
- **Bakgrunden rör sig inte, och det är ett beslut.** Här låg ett femte lager
  — "dust in lamplight", fjorton prickar som steg uppåt på UI-tråden — och det
  är borttaget på begäran. Det bodde **mellan** glöden och vinjetten, eftersom
  prickarna var View-ar och vinjetten skulle mörkna dem; det är därför
  toningarna en gång låg i två `Svg` i stället för ett. Med prickarna borta
  finns ingen anledning till skarven, och lagren ligger i ett `Svg` igen.
  - Det som försvann med dem: färgtokenen `DUST`, `SPECK_*`-konstanterna,
    `useReducedMotion()`-fallbacken (prickarna stod stilla på 0.6 i stället
    för att stiga) och hela Reanimated-importen i filen. **Reanimated är kvar
    i bundeln** — det är ett förval i Expos mall, låg i `package.json` långt
    före bakgrunden, och `app/_layout.tsx` har dessutom sidoeffekt-importen
    som expo-router kräver.
  - Vill någon ha rörelse här igen är det en **ny** funktion snarare än en
    återställning, och frågan att svara på först är varför en app som ber dig
    lägga ifrån dig telefonen ska ha något som rör sig i bakgrunden. Den gamla
    hade svar på det (fjorton prickar, 48–71 s per varv, en gloria på 5 px,
    aldrig `Math.random()` så att ytan inte hoppar vid flikbyte) — de
    avvägningarna bör göras om från början hellre än grävas upp ur git.

## Dagsmålet — ett personligt tal, med eller utan krets

`profiles.daily_target_seconds` är appens enda källa till sanning för dagsmålet
([supabase/dailygoal.sql](supabase/dailygoal.sql), som också flyttar över
gamla värden). Talet låg förr på `circle_members.daily_target_seconds`, och
det gjorde en personlig sak till något bara en grupp kunde ha: `set_daily_goal`
kastade "You are not in a circle." för alla andra, introduktionens målsteg
kunde inte spara siffran det just frågat om, och **ringen på Hem — appens mest
sedda yta — stod tom för den som pausar ensam.** Kretsen sätter inte
medlemmarnas mål och röstar inte om dem (se Circles nedan); platsen var fel,
inte regeln.

- **Kretsen läser talet, den äger det inte.** `evaluate_circle_goals`,
  `get_circle_progress` och `get_circle_wrapped` joinar `profiles`. Lägger du
  till en fjärde läsare, joina där också — en kopia tillbaka till
  `circle_members` och de två talen glider isär utan att något felar.
  Kolumnen på medlemsraden står kvar oläst och oskriven; kolumner droppas inte
  i den mappen.
- **Följden är att man tar sitt mål med sig in i en krets.** Avsiktligt, och
  det löser samtidigt "en medlem utan mål blockerar veckans bedrift" för alla
  som satt ett i introduktionen.
- **Ringen på Hem visas för alla som satt ett mål**: `of 30 min` utan `today`
  (ringen *är* dagen) och samma `DurationWheel` som Kretsen öppnar. Den är
  sidans huvudsak och tar nästan hela spalten — men **hur stor den blir
  räknas fram ur den uppmätta skärmen**, inte ur ett fast tal, och räkningen
  står vid `heroMetrics` i
  [app/(tabs)/index.tsx](app/(tabs)/index.tsx).
  **På Hem är ringen numera pausens två streck** ([components/liquid-bars.tsx](components/liquid-bars.tsx))
  med siffran under dem i stället för inuti. Räkningen är densamma:
  `hero.ring` är blockets höjd, och strecken tar det som blir kvar när
  siffran och målraden fått sitt. Kretsens hero har samma streck.
  **Strecken är numera en ring igen (`HOME_RING_VIEW = true`)** — samma ring
  som Kretsens ringvy ([components/progress-arc.tsx](components/progress-arc.tsx)),
  i rummets `hue` på `hueTrack`, med Kretsens proportioner (strecket 14/210,
  siffran 34/210) skalade mot den uppmätta storleken. Siffran står inuti och
  en bock när målet är nått; ringen får hela blocket utom målraden `− +`,
  aldrig bredare än spalten. `false` ger tillbaka strecken som de beskrivs här.
  **Ett tryck på ringen öppnar målratten (`RING_OPENS_GOAL = true`)**, och då
  står målet inuti ringen (`of 1h`) och raden `− 1h +` visas inte — ringen
  får dess höjd. `false` ger tillbaka raden och tar bort `of` ur ringen.
  **De stora ringarna glöder** (`glow` på `ProgressArc`, Hem och Kretsens
  stora ring, inte brickorna): en bred båge under den skarpa, målad med en
  radiell toning som är starkast mitt på strecket och tonar bort ut och in
  (`GLOW_HALF`, `GLOW_PEAK`). Den ersatte tre lager i olika styrka, som gav
  synliga trappsteg. Inga svg-filter: Androids `FeGaussianBlur` bygger en
  RenderScript per bildruta medan bågen fylls. Glödbågen är förskjuten och
  kortad i båda ändar så att dess rundade ändar slutar där den skarpa bågens
  gör. **Ringen på Hem är 80 % av platsen den har (`HOME_RING_SCALE`), högst
  230 px** — hela blocket kändes för stort.
  **Vattnet i strecken flyter hela tiden** (Hem och Kretsen): två vågor i
  oändliga slingor, 9 s och 14 s per varv åt var sitt håll, på UI-tråden. De
  är olika långa (90 / 130) och låga (3 / 4), den bakre står lite högre,
  vattnet mörknar mot botten och en ljus reflex följer krönet — för att det
  ska läsa som vätska och inte som ett mönster som glider, men lugnt. Ett
  skvalp (ytan som gungade upp och ner) fanns en kort stund och togs bort: det
  rörde sig för mycket. Formen, toningen och reflexen ritas en gång; bara
  transformer rör sig.
  **Vattnet följer telefonens lutning** ([components/liquid-tilt.tsx](components/liquid-tilt.tsx)):
  ytan står vågrät i världen, upp till ~25°, med en fjäder som skvalpar till.
  Gravitationssensorn läses av Reanimated direkt på UI-tråden, **en sensor per
  skärm** (provider runt Hem och Kretsen) och inte per streck, och den lever
  bara medan skärmen har fokus. Ligger telefonen platt står vattnet rakt. Med
  reducerad rörelse startas sensorn inte. Tecknet skiljer mellan iOS och
  Android (`GRAVITY_SIGN`) — står vattnet åt fel håll på en plattform är det
  det talet som ska vändas.
  **Strecken är glasrör:** en ljus kant runt om, mörkare sidor än mitt
  (rundning) och två reflexer, allt statiskt ovanpå vattnet (`GlassOverlay`).
  **Små bubblor stiger i vattnet** (`bubbles`-propen): tre per streck på Hem,
  två på Kretsens smalare streck, med fasta i stället för slumpade tal så att
  ytan ser likadan ut när man kommer tillbaka — men olika per instans, så att
  medlemmarnas bubblor inte stiger i takt. Inga bubblor med reducerad rörelse.
  **Två saker håller det jämnt på Android, och ingen av dem får tas bort:**
  vågskikten har `renderToHardwareTextureAndroid` (de cachas som textur och
  flyttas utan omritning), och `package.json` slår på Reanimateds
  `ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS`. Utan flaggan går varje bildruta av
  varje animerad vy genom React Natives skuggträd i New Architecture, och
  åtta streck i Kretsen räckte för att det skulle hacka. Flaggan läses vid
  bygget (Reanimateds android/build.gradle) — ändras den krävs en ny dev-build.
  Det är ett medvetet undantag från *Bakgrunden rör sig inte* — strecken är
  innehållet och inte bakgrunden, och de ska se ut som vatten. Slingorna
  stoppas när skärmen tappar fokus (flikar avmonteras inte) och står still med
  reducerad rörelse. De drev en tid bara efter en ändring och lade sig sedan;
  det ändrades på begäran.
  **Blocket står centrerat** i ytan mellan topbaren och flikraden, med jämn
  luft mellan streck, siffra, målrad och PAUSE-knapp (gapet mot knappen
  36–56). Det stod förankrat i nederkanten så länge att göra-lakanet låg där;
  med lakanet borta delas överskottet lika över och under.
  **Målet ändras på Hem med `− 1h +` under siffran**, inte genom att trycka
  på strecken; ratten finns kvar bara för det första målet (*Set a daily
  goal*). Stegen är ratten egna (`GOAL_OPTIONS`), och sparningen väntar
  `GOAL_SAVE_DELAY_MS` efter sista trycket så att en serie tryck blir en
  skrivning. Kretsens streck öppnar fortfarande ratten. (Med ringvyn och
  `RING_OPENS_GOAL` gäller det omvända: ringen öppnar ratten och raden döljs,
  se ringstycket ovan.)
  Dagssumman kommer alltid ur `get_daily_goal_progress()`, som summerar de
  egna `pause_sessions`. Den kom förr ur `get_circle_progress()` för den som
  var med i en krets; med upp till tre finns ingen enskild "kretsens dag", och
  ringen är ens eget tal. Enda skillnaden mot kretsflikens brickor är dagen
  man går med: ledgern räknar bara det som hänt medan man varit medlem.
- **Dagspåminnelsen räknar mot samma tal**, och läser det genom samma
  `get_daily_goal_progress()` som ringen utan krets — alltså inte en fjärde
  läsare av `profiles.daily_target_seconds` att hålla i takt, utan en andra
  anropare av en RPC som redan finns. Det är också skälet att notisens siffra
  följer reglerna för höjning och sänkning av sig själv: en sänkning ligger i
  `pending_target_seconds` och RPC:n svarar med ribban som faktiskt gäller.
  `enableDailyReminder()` anropas från `setDailyGoal()` — se notisavsnittet
  högst upp.
- **Utan mål står ringen ändå, tom, med *Set a goal* inuti** — ett tryck
  öppnar ratten. Förr stod bara rubriken `Ready for a pause?` med en länk
  *Set a daily goal* under, och länken doldes med krets och efter *Set up
  later*. Testare med nya konton såg då ingen ring alls och hittade målet bara
  via kretsfliken. Tomringen visas för alla, med eller utan krets: den är
  samma yta som sedan fylls, inte en uppmaning till. (Rubrikgrenen finns kvar
  bara för `HOME_RING_VIEW = false`.)
- **Solo-läget visar ringen och ingenting mer.** Potten, stegen, nivåmärket,
  flödet och reaktionerna kräver alla en krets och syns inte — och orden runt
  ringen nämner varken *circle* eller *together*, för det finns ingen och
  ingenting att dela. Ett tal man lovat sig själv är ett helt läge, inte en
  halv grupp.
- **`DurationWheel` bor i [components/duration-wheel.tsx](components/duration-wheel.tsx)**,
  inte längre inne i kretsfliken. Två skärmar väljer samma tal, och två kopior
  av ratten hade glidit isär — samma skäl som `intro-chrome.tsx` finns för att
  stegen inte ska bli sju skelett.

## Sömnläget — en natt är ingen paus

Användare lade telefonen nedåt över natten med en vanlig paus igång. Eftersom
dagen räknas på `ended_at` landade åtta timmar på **morgonen**: dagsringen
full klockan sju, kretsens pott och stege uppe åtta timmar på en natt, och
kretsens dagsmålsnotis ute för en natts sömn. Därför finns ett eget läge.
Schemat bor i [supabase/sleep.sql](supabase/sleep.sql), klientsidan i
[lib/sleep.ts](lib/sleep.ts) och [lib/homeMode.ts](lib/homeMode.ts).

- **En natt är `pause_sessions.kind = 'sleep'`**, och förvalet är `'pause'` —
  varje befintlig rad och skrivare (lådflödets kö, krasch-återställningen,
  delade pauser) skriver pauser utan att röras. Ingen gissning på längd eller
  klockslag: det är vad användaren tryckte på som avgör.
- **Varje läsare som räknar pauser filtrerar på `kind = 'pause'`.** I SQL:
  `get_daily_goal_progress`, `record_circle_pause` och grinden
  `analytics.counted_sessions`. I klienten: statistikens diagram, my-wrapped,
  `findOnce` i pauseTags, och vänfrågorna i friends/friend-wrapped. **En ny
  läsare som glömmer filtret räknar sömnen igen, och ingenting felar** —
  samma fälla som analysgrindarna finns för.
- **Natten är privat, och det är policyn som bär det.** SELECT-policyn på
  `pause_sessions` släpper bara igenom vänners rader med `kind = 'pause'`.
  Vänner läser `pause_sessions` rakt från klienten, så ett filter där vore
  bara en artighet. `record_circle_pause` vägrar en sömnrad även om en klient
  skickar dess id, så natten når aldrig ledgern — och därmed varken potten,
  stegen, veckomålet eller dagsmålsnotisen. `is_pausing` sätts inte under en
  natt, och natten loggas inte i den lokala pausloggen.
- **En natt hör till kvällen den började**, med gränsen vid lokal middag
  (`sleep_night_of()`). En sömn som börjar 01:00 tisdag är alltså
  måndagsnatten.
- **Det finns inget nattmål, och det ska inte komma tillbaka utan ett nytt
  skäl.** Ett fanns en kort tid (`profiles.nightly_target_seconds`,
  `set_night_goal`, en ratt på 5–10 h) och togs bort. Appen kan inte få någon
  att sova längre — bara påverka telefonen: när den läggs ner och om den tas
  upp. Timmarna är mest hur länge någon sov, och ett missat nattmål läses som
  ett omdöme om natten, alltså skuld, som är fel motor i den här appen.
  Natten **spåras**: läggdags, längd, uppvaknanden. Kolumnen står kvar oläst
  (kolumner droppas inte); funktionen droppas i sleep.sql. Ingen notis heller.
- **Flödet är pausens eget** ([app/pausing.tsx](app/pausing.tsx),
  `pauseType: 'sleep'`), med samma frysning när telefonen lyfts. Skillnaderna:
  - Ett lyft efter första nedläggningen är ett **uppvaknande**. Det räknas
    (`wake_count`, `awake_seconds`) när telefonen läggs ner igen; lyftet som
    avslutar natten räknas inte.
  - Natten **tar slut av sig själv** när telefonen varit uppe i
    `SLEEP_AUTO_END_MS` (20 min) **med appen framme** — räknat från lyftet
    eller från att appen kom fram, det som är senast. Annars hade en natt
    avslutats i samma ögonblick som appen öppnades efter ett lyft vid tre.
    Skärmen säger det inte längre (raden *The night ends after 20 min
    awake* togs bort på begäran) — den visar bara *Clock paused*.
  - **Natten slutar vid lyftet**, inte vid knappen eller när fristen gick:
    `started_at` är första nedläggningen (läggdags), `ended_at` lyftet.
  - **Den går inte att backa ur** (BackHandler + `gestureEnabled: false`). En
    övergiven paus kastas — rätt för en paus, en förlorad natt för en natt.
  - Inget uppåtljud — ett pip vid tre väcker den som ligger bredvid.
  - Knappen heter **Finish**, som pausens — samma ord, röd och hållen.
    (Den hette en kort stund *End night*; ett eget ord för samma handling
    gav bara två knappar att lära sig.) Bara `accessibilityLabel` säger
    *Finish the night*.
  - Krasch-återställningen räknar en natt till **nu** om appen lämnades
    nedåtvänd och still (`runningAtLeave` i checkpointen), eftersom iOS gärna
    dödar en app i bakgrunden under natten; annars stannar den vid pulsen.
    Tak: `SLEEP_MAX_SECONDS` (16 h). Kortare än `SLEEP_MIN_SECONDS` (5 min)
    sparas inte.
- **Det som inte går att se är samma gräns som pausens, och den svider mer en
  natt.** Lyfts telefonen till en annan app syns det inte förrän Pause öppnas
  igen. Låser man telefonen i handen innan den läggs ner fryser klockan när
  appen lämnas, och står frusen tills appen öppnas — hela natten. Skärmen
  säger därför *let the screen turn off by itself* före första nedläggningen.
- **Hem byter läge med en Day / Night-kapsel** ovanför hälsningen.
  Förvalet följer klockan (natt 20–05); ett eget val står sig i fyra timmar.
  Läget bor i en delad butik ([lib/homeMode.ts](lib/homeMode.ts)) och inte i
  skärmen, för tre läsare måste vara överens: Hem, flikraden och botten bakom
  scenerna. **Nattläget flyttar Hem till `night`-rummet** — mörkt i båda
  lägena, samma rum som natten pågår i — och flikraden följer med, inklusive
  det inaktiva bläcket. Statusraden tvingas ljus bara medan fliken har fokus.
- **Nattläget är en måne och SLEEP-knappen, ingenting annat**
  ([components/night-moon.tsx](components/night-moon.tsx)). Ingen siffra,
  ingen klocka, inga uppvaknanden: allt om natten som gått står i
  statistiken, och sidan finns för knappen. Under månen står *Ready for bed?*.
  Att göra-lappen i hörnet visas inte heller i nattläge — den hör till dagen.
  - Den har varit två saker före månen, och båda togs bort: en **ring mot ett
    nattmål** (målet är borta, se ovan) och en **urtavla** med bågen från
    läggdags till uppvaknande, timmarna i mitten och `23:10 – 07:02 · woke
    2×` under. Urtavlan visade sånt statistiken redan visar, och drog blicken
    från det sidan är till för. Lägg inte tillbaka nattens siffror här.
  - Månen är svg: en gloria i rummets `hue`, skivan, skuggan som gör den till
    en skära (en **mask** — en cirkel målad i bakgrundens färg hade synts som
    en fläck mot toningen), och åtta stjärnor på fasta platser. **Inget rör
    sig.**
- Nattläget har ingen intention, ingen valskärm (SLEEP startar direkt, hållen)
  och ingen sammanfattning: natten slutar på Hem **i dagläge** — det är morgon
  (`markNightEnded` väljer `day`, som ett eget val så att gårdagens nattval
  inte står sig).
- **Statistiken har en liten sektion SLEEP** över pauserna, med tre tal:
  **sviten** (nätter i rad med SLEEP, oavsett längd), **snittläggdags** och
  **snittsömn**, över de senaste 30 nätterna. Den syns bara när det finns en
  natt, och har inga rader per natt — varje natt står redan som eget kort i
  listan. Ett veckodiagram (sju streck från läggdags till uppvaknande) stod
  där en kort tid och togs bort på begäran. Sammanfattningen ligger på samma
  natthimmel som nattkorten, med nattpalettens text.
  - Sviten belönar vanan att lägga undan telefonen, inte sömnen — därför
    räknas varje natt. Den börjar i natten som gäller nu eller natten innan
    (på eftermiddagen har kvällens natt inte börjat, och det är inte ett
    brott); en saknad natt bryter den. Vilken natt som "gäller nu" kommer ur
    `get_night_progress`, inte ur klientens klocka.
  - Läggdagens snitt räknas runt midnatt (`avgBedtime`): 23:30 och 00:30 ger
    00:00, inte 12:00.
  - **Nätterna står också i listan under *Recent pauses***, som egna kort med
    natthimmel och en SLEEP-tagg
    ([components/sleep-session-card.tsx](components/sleep-session-card.tsx)).
    Kortet läser all sin text ur **nattpaletten** och inte ur statistikens —
    himlen är mörk i båda lägena, och ljuslägets bläck hade försvunnit i den.
    Stjärnorna räknas ur radens id och står still. Inga taggar, ingen vän,
    inget meddelande; svepet raderar som för en paus, och SLEEP hämtas om.
  - **Himlen bor i [components/night-sky.tsx](components/night-sky.tsx)** och
    delas av nattkorten och sammanfattningen. Den **mäter sitt kort** och
    ritas i pixlar: som en svg med `width="100%"` över `absoluteFill` löstes
    procenten inte upp mot kortets verkliga höjd, och himlen såg avklippt ut.
    Gå inte tillbaka till procent.
  - **Diagrammet ovanför listan räknar bara pauser** (`pauseSessions`) — en
    natt hade gjort det till ett sömndiagram.
- **Körordning:** sleep.sql först, sedan om dailygoal.sql, circles.sql och
  analytics.sql. Klienten filtrerar på `kind`, så **en app med det här ute
  före SQL:en får tomma listor** i statistik, wrapped och Friends.

## Circles

Tredje fliken, [app/(tabs)/circle.tsx](app/(tabs)/circle.tsx) — en liten
grupp (2–10 personer, mjuk gräns, bara styr hur många man kan bjuda in). Man
kan vara med i upp till tre — se *Flera kretsar* nedan. Schema + RLS + RPC:er
ligger i
[supabase/circles.sql](supabase/circles.sql) — det finns inget
migrationsverktyg i det här projektet, filen körs för hand i Supabase
SQL-editorn (samma konvention som RPC-kommentaren högst upp i
`app/add-friend.tsx`).

- Allt utom `circle_weekly_goals` muteras bara via `security definer`-RPC:er
  (samma anda som `cancel_shared_pause`/`get_partner_session_status`) —
  det är där invarianterna sitter (max 8, en cirkel per person, reglerna för
  veckomålet nedan).
- **Att skapa en krets går genom
  [app/circle-create.tsx](app/circle-create.tsx), inte genom ett namnfält.**
  Två steg — vad en krets är, och sedan namnet — innan `create_circle`
  anropas. Det som inte går att gissa sig till är att dagsmålet är ditt eget
  och inte något kretsen delar ut, och att veckan ändå kräver allas
  (`goals_set_count = member_count`). Sidan säger just de två sakerna, delad
  i **YOU / THE CIRCLE / TOGETHER** — vem som gör vad, inte numrerade regler,
  för tre punkter i en lista läser alla som villkor.
  - **Mekaniken står inte här.** Ett utkast hade en tredje sida med potten på
    94%, stegen som inte skrivs om när någon lämnar, och varningen om att en
    medlem utan mål blockerar veckan. Allt tre är sant och allt tre beskriver
    siffror som står på kretsfliken — före en krets som ännu inte finns läses
    de som villkor för ingenting. Lägg inte tillbaka dem här; hör de hemma
    någonstans är det bredvid talen de handlar om.
  - Skärmen bygger sina steg av `IntroStep`/`useIntroStyles` i
    [components/intro/intro-chrome.tsx](components/intro/intro-chrome.tsx) —
    samma skelett som introduktionen, men båda stegen i en fil: de är text
    och ett textfält, och delar det enda tillstånd som finns.
  - Sista steget lämnar över till `circle-invite` med `replace` och
    `from=create` (inte `push`): kretsen finns redan, och att kunna backa in
    i namnfältet igen ger bara "You are already in a circle." Parametern är
    också det som ger invite-skärmen sin avslutsknapp — där bakåt annars
    betyder "tillbaka till kretsen" skulle den efter ett skapande läsas som
    ett ångrande.
  - **Den som tar emot en inbjudan får samma genomgång, på en sida.**
    [app/circle-welcome.tsx](app/circle-welcome.tsx) visar YOU / THE CIRCLE /
    TOGETHER efter bocken i `circle.tsx`s `invitesSection`. Det var förr en
    känd lucka: de flesta medlemmar kommer in just den vägen, och reglerna
    ovan nådde dem aldrig. Tre skillnader mot skaparens version, och alla tre
    är avsiktliga — rubriken namnger kretsen i stället för att beskriva vad en
    krets är (den finns ju redan), blocken är ett steg och inte tre (hen har
    redan tryckt ja och vill in), och det finns ingen bakåtlänk (det finns
    ingenstans att backa till).
    - **Blocken delar `IntroPart` med skaparens sida.** Komponenten bodde i
      `circle-create.tsx` och flyttade till
      [components/intro/intro-chrome.tsx](components/intro/intro-chrome.tsx)
      när den fick två läsare. Poängen med sidan är igenkänningen — den som
      läst den och senare själv skapar en krets ska möta samma sida — och två
      kopior hade glidit isär. Samma skäl som `duration-wheel.tsx` finns för.
    - **Flaggan sätts vid accepterandet och rivs vid `Got it`**, inte vid
      visning (`setPendingCircleWelcome`/`clearPendingCircleWelcome` i
      [lib/introPrefs.ts](lib/introPrefs.ts), per enhet som temat). Stängs
      appen mitt i sidan kommer den tillbaka. Att flaggan bara *sätts* vid
      ett accepterande är också det som gör att ingen befintlig medlem möts
      av sidan efter en uppdatering, och att skaparen aldrig ser den.
    - **Navigeringen sker i `load()`, inte i `handleAcceptInvite`**, så att
      vägen till sidan är en och samma oavsett om man kom via bocken eller
      via en app som stängdes. `welcomeCheckedRef` gör det till ett försök
      per montering: `load()` kör var fjärde sekund, och en navigering som
      upprepas så ofta vore en fälla och inte en sida.
- **Veckomålet är en tabell av personliga mål, inte ett tal.** Varje medlem
  sätter sitt eget `profiles.daily_target_seconds` (`set_daily_goal`) — talet
  bor på profilen och inte på medlemsraden, se Dagsmålet ovan.
  Cirkelns pott för veckan är summan av dem, men målet är nått först när
  **varje** medlem klarat sitt eget — potten kan alltså stå på 94% och ändå
  vara olåst. Det är meningen, och skärmen måste säga det rakt ut, annars
  läses det som en bugg — den gör det i den utfällbara listan, bredvid
  raderna som visar vem som fattas, där meningen blir begriplig i stället för
  kryptisk. Listan är hopfälld som förval; kortet är knappen som fäller ut
  den. Vecka = måndag 00:00 UTC (`circle_week_start()`), samma gräns för alla
  oavsett tidszon.
  - **Höjning gäller genast, sänkning alltid från nästa måndag.** Inget
    villkor om huruvida man hunnit pausa (den regeln fanns förr och är
    borttagen, liksom fältet `paused_this_week` som bara tjänade den) — den
    här är både enklare att förklara och omöjlig att spela: veckan kan aldrig
    vinnas på en ribba som sänkts medan den pågick. En sänkning parkeras i
    `pending_target_seconds` och är inert tills veckoskiftet promotar den, så
    varken potten eller utvärderingen kan se den. Höjer man medan en sänkning
    ligger och väntar rivs den — man har ändrat sig om att sänka.
  - Svaret från RPC:n har `deferred: true` vid en sänkning, vilket skärmen
    **måste** berätta, annars ser användaren sin gamla siffra kvar och tror
    att sparningen misslyckades. Regeln står inte skriven i modalen — raden
    **STARTS NEXT WEEK** dyker upp först när man snurrar under sitt
    nuvarande mål. Den är alltid renderad och bara osynlig när den inte
    gäller, annars flyttar sig knappen under fingret medan man snurrar. En
    väntande sänkning visas som "Next week: 30 min" under ringen i heron och
    i den egna raden.
  - Flödestexten för en sänkning säger bara "adjusted their goal from next
    week" — utan siffra, aldrig "lowered". En höjning loggas med
    `raised: true` i metadatan och blir "raised their goal to 1h"; ett
    första mål blir "set their weekly goal to 1h". Sätter man om samma
    siffra som redan gäller loggas ingenting alls.
  - **Ingen synlighetsinställning gäller de här raderna.** Det finns ingen
    per-användare-inställning för måländringar; `profiles.show_stats` styr
    vänner-fliken, skrivs `false` vid registrering och ignoreras medvetet
    inne i cirklar. Ska måländringar kunna döljas behövs en ny flagga.
  - Ingen röstar om någons siffra, och cirkeln har ingen delad fritext alls:
    `propose_group_goal`/`confirm_group_goal` och kolumnen `circles.group_goal`
    (som en kort stund hette `pact`) är borta. En röstning om ett tal någon
    annan ska leva upp till är meningslös, och en fritext som ingenting läser
    och vem som helst kan skriva över höll inte ihop det den skulle hålla
    ihop. Det delade är potten och stegen; det personliga är veckomålet och
    planerna.
  - **Ordvalet i UI:t:** siffran heter *goal*. Raderna som förr hette *plans*
    heter numera *to do* på båda skärmarna — se *Att göra* nedan. Ordet fick
    inte vara *goals* då och får inte vara det nu: annars finns det två olika
    saker med samma namn på samma skärm. Tabellen och aktivitetstypen
    `weekly_goal_updated` behåller sina gamla namn; bara orden användaren ser
    ändrades.
  - **Att göra är tillbaka, som en lapp och inte ett lakan.** Lakanet *To do*
    längst ner på Hem och kretsflikens sektion *To do* revs för att de tog för
    mycket plats. Listan kom tillbaka på begäran som **ett hörn av en post-it
    som sticker upp nere till vänster på Hem** (`TodoPostIt` i
    [components/todo-sheet.tsx](components/todo-sheet.tsx)), med arket bakom
    den, och i kretsfliken som **en rad lappar, en per medlem**
    (`CircleTodoNotes`).
    - **Lappen ligger under PAUSE-knappens golv**, alltså inom de 56 punkter
      som `MIN_BOTTOM_GAP` + `BOTTOM_PAD` alltid lämnar fria i
      [app/(tabs)/index.tsx](app/(tabs)/index.tsx). Därför behöver heronens
      räkning inte veta om den. `PEEK_H` är 54; blir lappen högre än 56 måste
      den in i `heroExtras`. Den döljs medan taggkortet står uppe, för de
      ligger över samma hörn.
    - **Lappen visar två punkter** (`POST_IT_ITEMS`), med små rutor och `+N`
      för resten, och etiketten `TO DO` bara när listan är tom. Den visade
      förr etiketten och en halv rad, och det var den halva raden som
      rapporterades som avklippt. Etiketten fick ge plats: rutorna säger
      redan "att göra".
    - **Lappen guppar upp `BOB` (18) varje gång Hem får fokus** och sjunker
      tillbaka — hörnet lästes annars som avklippt och inte som något att
      trycka på. Klippet är `BOB` högre med samma tal i `paddingTop`, så
      vilan är oförändrad och heronens räkning behöver inte veta om guppet.
      Inget gupp med reducerad rörelse.
    - **Pappret är inte palettstyrt** (`PAPER`), av samma skäl som regnbågen på
      nivåmärket: en post-it har sin egen kulör, och `highlight` är senapsbrun
      i ljust läge. Det är **gult** (`#f6dd7a` ljust / dämpad `#e6cb68`
      mörkt) med plommonbrunt bläck. En kort stund var det ljus pastell-lila,
      men gult togs tillbaka på begäran — en post-it ska se ut som en post-it.
    - **Arket är den egna listan**: skriva, bocka av, ångra, radera. Avbockade
      punkter syns en vecka (`DONE_VISIBLE_DAYS`), sedan bara i databasen.
      - **Det är samma papper som lappen** (`PAPER`, inte rummets
        `modalSurface`), med tejp i stället för greppstreck och lappens bläck
        på bockarna. Plusknappen är däremot accentens blå — den är det enda
        ifyllda, och ifyllt är accenten i hela appen. Kretsens läsark delar
        utseendet.
      - **Det växer fram ur lappen**: lappens ruta mäts vid trycket
        (`NoteRect`), och arket börjar där i lappens storlek och vridning och
        krymper tillbaka dit när det stängs. Lappen döljs under tiden
        (`lifted`), annars finns den två gånger. Modalen har genomskinliga
        system-fält så att dess koordinater är fönstrets. Kretsens väg in har
        ingen lapp att växa ur och glider upp som förut. Inget växande med
        reducerad rörelse.
      - **Det är linjerat**: blå linjer och en röd marginal, som ett gult
        block. Varje rad är exakt `LINE` (36) hög och linjerna ritas bakom
        med samma steg, så texten står *på* linjerna. Allt i listan måste
        vara en multipel av `LINE` — en marginal förskjuter allt under sig,
        och därför har *Ticked off this week* en tom rad ovanför sig.
        Bocken, ögat och krysset står vid radens **första** linje, inte
        centrerade: en punkt som bryter är två `LINE` hög, och centrerat
        hamnade ikonerna rakt på linjen mellan raderna. Avbockade punkter
        har ingen tidsstämpel (*just now*) — rubriken säger redan veckan;
        den står bara kvar i `accessibilityLabel` på kretsens lappar.
      - **Att bocka av ger en pappersknäpp**: ett `Rigid` och ett `Light`
        70 ms senare. Att ångra ger bara ett `Soft`.
    - **Punkterna är handskrivna, i Kalam**
      ([lib/handFont.ts](lib/handFont.ts), `@expo-google-fonts/kalam`) — på
      lappen, i arket och på kretsens lappar. Bara punkterna, aldrig
      etiketter, knappar eller fotnoter: det någon *skrivit* ska se skrivet
      ut. Caveat satt där först och valdes bort på begäran; de rundare
      handstilarna läser som en barnbok. `useHand()` skalar storleken efter
      typsnittets x-höjd (`HAND_SCALE`, prövas om vid byte) och sätter ingen
      `fontFamily` förrän typsnittet är laddat.
    - **Arket lyfter sig själv över tangentbordet**, med höjden ur
      `Keyboard`-händelserna — samma lösning som circle-chat.tsx, och av
      samma skäl: med `edgeToEdgeEnabled` gör KeyboardAvoidingView ingenting
      på Android. Lägg inte tillbaka en KAV ovanpå, då räknas tangentbordet
      två gånger.
    - **`onChanged` läses ur en ref i arket.** Kretsfliken skickar en ny pil
      vid varje `load()`, och som beroende nollade den fältet mitt i
      skrivandet var fjärde sekund.
    - **Kretsens lappar står mellan ringen och flödet**, i ringens ordning
      (man själv först, aldrig sorterat efter tal). Varje lapp visar fyra
      punkter, öppna först och sedan veckans avbockade, överstrukna. Den egna
      lappen öppnar arket, de andras öppnar hela listan som bara går att läsa.
      Väljs någon i ringen rullas hens lapp fram och de andra tonas bak, som
      brickorna. Listorna hämtas i `load()` (var fjärde sekund), så en bock
      syns lika fort som i flödet.
    - **Bara kretsen ser listan, inte vännerna, och det står där man skriver**
      (*Your circle can see this list.* / *Only you see this list until you
      join a circle.*). Policyn på `wishlist_items` släpper igenom egna rader
      och kretskamraters (`shares_circle_with`,
      [supabase/wishlist.sql](supabase/wishlist.sql)). Vänner prövades en kort
      stund (`is_friend_with`, som filen nu droppar) och valdes bort av två
      skäl. Vänlistan har ingen övre gräns. Vänner ser inte ens pausaktivitet
      utan `show_stats`, så en lista som är mer personlig än pausminuter kan
      inte vara synlig för dem som förval. Vill man visa en enskild punkt för
      vänner gör man den till en story via *Ask for support*.
    - **En punkt kan döljas för kretsen** med ögat med streck i arket
      (`wishlist_items.hidden_from_circle`, inte `private`, som är reserverad
      för utmaningar). Ikonen visar läget som i ett lösenordsfält: öppet öga
      när kretsen ser punkten, överstruket när den är dold, båda i fullt
      bläck. (Först var det samma överstrukna öga i två styrkor, och det gick
      inte att se vilket läge som var vilket.) Den gäller alla ens kretsar på en gång.
      Spärren sitter i SELECT-policyn **och** i de två definer-funktionerna
      som går förbi den: `complete_wishlist_item` skriver ingen flödesrad för
      en dold punkt (raden bär texten), och `circle_weekly_completions`
      filtrerar bort den. En ny definer-läsare av listan måste filtrera
      likadant. Ens egna dolda punkter visas inte på den egna lappen i
      kretsfliken — den lappen visar vad kretsen ser — men står på Hem och i
      arket, och fotnoten säger *except hidden items*.
      **Kör wishlist.sql igen före appen:** klienten väljer kolumnen, och
      utan den blir listan tom.
    - **Att bocka av går genom `complete_wishlist_item`**, så kretsens flöde
      får sin `wishlist_completed`-rad som förut. Att ångra en bock är en
      direkt update, och flödets rad står kvar.
    - Allt läses och skrivs i [lib/todos.ts](lib/todos.ts). *Ask for
      support* läser fortfarande listan direkt (gruppen *On your list*), och
      den gruppen fylls nu på igen.
  - **Ringvyn (`CIRCLE_RINGS_VIEW = true`) ersätter streckvyn nedan.** Överst
    en ring för hela kretsen (allas minuter mot allas mål, `potTotals`), med
    etiketten `EVERYONE`; under den en liten ring per medlem, fem i bredd,
    man själv först och aldrig sorterat efter tal; varje ring fylls mot
    medlemmens eget mål för perioden och tar stopp vid full. **Ett tryck på
    en bricka låter den stora ringen visa den medlemmen** — ansiktet, namnet,
    tiden, `of {mål}` (med bock när det är nått), och bågen glider till hens
    andel av sitt eget mål — och de andra brickorna tonas bak. Ett tryck till
    på samma bricka, eller på ringen, går tillbaka till `EVERYONE`. Inget
    annat sätt ut finns, och det är valt: fem synliga vägar ut (en rad med
    en mening, sedan tre tal; en kapsel *‹ Whole circle*; en knapp till
    vänster om ringen; en *Everyone*-bricka; ett kryss på ansiktet) och ett
    mörkt tittskikt över sidan prövades och föll. Andelen av kretsens tid
    visas inte. Periodvalet står centrerat ovanför ringen, lyft en bit
    (`periodPill`), med datumet strax under sig.
    - **Man bläddrar bakåt med pilarna på var sin sida om datumet.** Kapseln
      heter därför *Week | Day* och inte *This week | Today*: den är stegets
      storlek, inte "nu". Idén kom från en testare, och poängen är att se
      både sina egna och de andras gångna veckor på samma ställe som talen
      redan står.
      - **Ett svep över ringen fanns en kort stund och togs bort på
        begäran:** ett vågrätt drag på en lodrät sida blev för lätt en
        rullning. Lägg inte tillbaka det.
      - **Den valda medlemmen följer med bakåt.** Medan en period hämtas
        står de nuvarande medlemmarna kvar, och den som är vald men inte var
        med då läggs till med noll — annars föll ringen tillbaka till
        `EVERYONE` mitt i bläddringen.
    - **Reglerna är statistikens** (`pause-activity-chart.tsx`): framåt tar
      stopp i nuet, byte av period eller krets landar i nuet igen, och bakåt
      tar stopp vid kretsens första dag (`circles.created_at`) — inget annat
      tak. *Back to this week ›* / *Back to today ›* står under datumet när
      man är bakåt; raden är alltid renderad och bara osynlig i nuet, så att
      ringen inte hoppar.
    - **Pågående period läses ur `get_circle_progress`, en gången ur
      `get_circle_period`** ([supabase/circles.sql](supabase/circles.sql)),
      en gång per bläddring och inte i fyrsekunderspollen. Den visar
      medlemmarna som var med då; den som lämnat står nedtonad, för timmarna
      ligger kvar i ledgern och brickorna ska gå ihop med summan. En gången
      period visar ingen *Set your goal* och ingen *N OF M GOALS SET* — de
      handlar om nu. En vunnen vecka visar sin `GOAL REACHED · WEEK N`.
    - **Målen som gällde då sparas i `circle_week_goals`**, skriven av
      `snapshot_circle_week_goals()` från `evaluate_circle_goals` (raden för
      pågående vecka skrivs om tills veckan vänt). Målet bor annars bara på
      `profiles` och skrivs över, så **de verkliga målen börjar den dag
      tabellen kom till.** Veckorna före det fylldes en gång med varje
      persons *nuvarande* mål (på begäran, oktober 2026) — en uppskattning,
      för en tom ring med *no goal* lästes som att vännen inte haft något
      mål. Fyllnaden rör bara veckor före kretsens första sparade vecka och
      skriver aldrig över en sparad rad, så circles.sql går att köra om. En
      vecka helt utan rader visar timmarna med en tom ring och *no goals
      saved*. En gången dag räknas i tittarens tidszon, samma regel som
      `today_seconds` — den visar bara och låser aldrig upp något.
    - **Körordning:** kör om circles.sql före appen; utan den svarar
      `get_circle_period` med fel och en gången period står tom.
    Rubriken bär bara chatten; belöningen, veckan, medlemmarna och utgången
    står i kretsens meny (tryck på kretsens namn). **Totalkortet och *See
    everyone* står inte i ringvyn** — summan står i ringen och var och ens tal
    på brickan; bara kortets statusrad (`GOAL REACHED` eller `N OF M GOALS
    SET`) flyttade upp under ringen. Ett befintligt mål ändras därför på Hem
    (`− +`); *Set your goal ›* står under raden när det egna saknas. Flödet
    under är oförändrat. Ringarna är
    [components/progress-arc.tsx](components/progress-arc.tsx) — svg med
    `strokeDashoffset` på UI-tråden, fylls från tomt på ~0,9 s när skärmen
    öppnas och när perioden byts, platta färger. **Ingen "pausar nu"-prick:**
    kretsfliken har inte den uppgiften, och att hämta `profiles.is_pausing`
    vore en ny fråga. `false` ger tillbaka streckvyn som den beskrivs nedan.
  - **Potten är sidans huvudsak, i designreferensens ordning:** kapseln
    *Week / Day* (hette *This week / Today* före bakåtbläddringen) ([components/segmented-pill.tsx](components/segmented-pill.tsx)),
    raden `YOUR CIRCLE` med periodens datum, medlemmarnas streck över hela
    bredden, den valda medlemmen i ord, och summan i ett kort under. Det är **en** uppsättning streck och ett kort —
    pagern och prickarna är borta, och kapseln byter period genom att strecken
    glider till sina nya nivåer.
    - Kapseln är ett medvetet undantag från "inga kapslar": den är ett val,
      inte en etikett. Markeringen är **fylld i rummets kulör**, med vit text i
      ljust läge och rummets mörka botten som text i mörkt. Det är skälet att
      Kretsens ljusa `hue` är `#23845a` och inte `#2e8b57`: vitt på den förra
      är 4.7:1, på den senare 4.2:1.
  - **Varje medlem är ett streck i potten** ([components/liquid-bars.tsx](components/liquid-bars.tsx)),
    man själv först och resten i kretsens egen ordning, **aldrig sorterade efter tal** — potten är en
    summa, inte en topplista. Fyllnaden är medlemmens tal mot sitt eget mål för
    perioden; ett tryck väljer strecket och visar namn, tal och andel av
    potten under raden. Man själv är valt som förval. *See everyone* står kvar
    längst ner i kortet: den säger vem som saknar mål, vilket ett tomt streck
    inte gör.
    - **Vattnet är pausens blå, inte kretsens gröna** — samma `hue` som Hem
      (`roomPalette(mode, 'pause')`), med en blå ton som tomt rör. Strecken
      är pausens symbol och ska se likadana ut var de än står; rummet syns i
      allt runt omkring (markeringsringen, namnet, kapseln).
  - **Raden under strecken bär `Set your goal ›` när det egna målet saknas**,
    i rummets kulör och till höger. Länken gäller alltid en själv, vem som än
    är valt, för uppmaningen får inte gömmas — se *Set your goal* nedan. När
    ett mål finns står ingen länk där (`Your goal: 6h a day ›` var en stund och
    togs bort på begäran); målet ändras på Hem (`− +`) eller i den egna raden
    under *See everyone*.
    - **Veckan är förvalet, och ska förbli det.** Dagen avgör ingenting:
      trofén, sviten och `circle_goal_achievements` hänger alla på veckan.
      Leder man med dagen gömmer man belöningen bakom ett tryck och visar
      i stället ett tal som inte registreras någonstans.
    - Utfällningen (*See everyone*) följer perioden och visar dagens siffror
      när *Today* är vald.
    - **Dagens siffror räknas i klienten, inte i SQL.**
      `get_circle_progress()` skickar redan varje medlems `today_seconds` och
      `daily_target_seconds`, så dagens pott är summan av delar som finns i
      svaret. Ingen RPC och ingen migration behövdes — och veckoribban *är*
      dagsmålet gånger sju, så de två sidorna mäter samma löfte över två
      längder.
    - **Dagen låser aldrig upp något, och får inte börja göra det.** Veckan
      har `goal_reached` med `circle_goal_achievements` bakom sig. Dygnet
      räknas däremot mot klientens egen midnatt (`p_tz_offset_minutes`), så
      två medlemmar i olika tidszoner ser olika dagspotter. Det är ofarligt
      så länge dagen bara *visar* — därför saknar dagsidan trofén med flit.
      Skulle en **delad** dagsbedrift någon gång behövas måste dygnsgränsen
      först bli delad, precis som veckans måndag 00:00 UTC.
      - Ordet *delad* bär hela regeln, och det är värt att vara noggrann med:
        kravet gäller tal som jämför eller summerar medlemmar mot varandra,
        alltså potten. `daily_goal_achievements` (se *Kretsens
        dagsmålsnotis* högst upp) är en dagsbedrift som trots det **inte**
        kräver en delad gräns, eftersom den bara säger att en person nådde
        sitt eget mål under sin egen dag — ingen jämförs med någon, och bara
        den personens egen telefon avgör när hennes dygn började. Skulle
        den siffran någon gång börja räknas ihop till något kretsen äger
        gäller kravet igen.
- **Stegen räknas ur `circle_pause_ledger`, inte ur en summering vid
  läsning.** En rad per räknad paus, unik på `session_id`. Skillnaden syns
  först senare: en medlem som lämnar skulle annars radera timmar cirkeln
  faktiskt klättrat, och en ny medlem skulle teleportera cirkeln flera nivåer
  på historik hen samlat ensam. `session_id` är därför `on delete set null` —
  raderar någon en egen paus i `stats.tsx` skrivs inte gruppens historia om i
  efterhand.
  - **Tio nivåer med namn, och två källor som måste hållas i takt.**
    Trösklar i timmar: 0/5/12/25/50/100/200/400/800/1500, och nivå 10 är
    taket. *Numret* räknas i `circle_level_for_seconds()`
    ([supabase/circles.sql](supabase/circles.sql)), för det är där
    `circle_level_ups` och flödets `level_up` skrivs. *Namnen och listan* bor
    i [lib/circleLevels.ts](lib/circleLevels.ts), som speglar exakt samma
    trösklar för att kunna rita hela stegen utan en rundtur till servern.
    Ändras en siffra måste båda ändras — annars visar brickan en nivå och
    aktivitetsflödet en annan, och ingen typkontroll fångar det.
  - **`Legendary` och `MYTHICAL` bryter namnmönstret med flit.** De saknar
    `Pausers`-suffixet. Det är inte en inkonsekvens att städa bort; de ska
    sticka ut mot de åtta stegen under. Versalerna är en annan sak:
    `LEGENDARY` skrevs om till `Legendary`, och `MYTHICAL` står kvar versalt
    tills någon säger till. I rubrikens nivårad versaliseras alla namn ändå
    av `toUpperCase()`, så skillnaden syns bara i stegen-modalen.
  - Skalan ersatte en äldre (5/15/40/100/250/500, sedan +500 utan tak). Rader
    som redan ligger i `circle_level_ups` behåller sina nummer men betyder nu
    andra timintervall. Hur den historiken städas står i SQL-filen vid
    funktionerna.
  - **Stegen har ingen egen sektion i fliken.** Ingången är
    nivåns märke följt av `LEVEL 6` **på samma rad** (chevronen efter togs
    bort på begäran — märket visar självt att det går att trycka), direkt under
    cirkelns namn — versal accenttext, ingen kapsel, enligt layoutspråket
    nedan — och hela listan i en modal bakom båda. Nivåns namn stod förr på
    raden (`LEVEL 6 · UNSHAKEABLE PAUSERS`) och togs bort på begäran; det
    står i modalen och i `accessibilityLabel`.
  - **Märkena bor i
    [components/circle-level-badge.tsx](components/circle-level-badge.tsx)**,
    inte i `lib/circleLevels.ts`. Den filen är den rena, ställbara tabellen
    över namn och timmar; hur ett steg *ser ut* är en annan sak och hör till
    komponenten. Lägger man till ett steg måste båda listorna växa — de
    indexeras på samma sätt (index 0 = nivå 1).
    - **Ritade utan `react-native-svg`** trots att biblioteket numera finns i
      bundeln (se *Plommon, rum och bakgrunden*). Skälet är inte längre att en
      native-modul saknas utan att de inte behöver en: ett märke är en **form**,
      och en form går att bygga av kanter. Toningar går inte, och det är därför
      bakgrunden fick undantaget och det här inte gjorde det. Att skriva om dem
      i svg vore en ändring utan ett syfte. Stjärnan bakom skivan är N
      kvadrater vridna `90 / N` grader ifrån varandra — två ger åtta uddar,
      fyra ger sexton. Geometrin hänger ihop: en kvadrat med sidan
      `0.66 × size` har hörnen `0.47 × size` från mitten medan skivan når
      `0.34`, och det glappet *är* uddarna. Ändrar man skivan måste
      kvadraterna följa med, annars slukas stjärnan eller spretar utanför.
    - **Upptrappningen är hela poängen.** Alla tio har färg, och tonen
      vandrar uppför spektrumet: mossgrön → grön → turkos → blå → ljusblå →
      lila → orkidé → rosa → guld → regnbåge. Samtidigt växer stjärnan (0 →
      16 uddar), ringen blir dubbel från steg 6 och glöden tänds vid 8.
      Stjärnan börjar på steg 5 med två kvadrater: steg 4 hade en, och en
      ensam kvadrat läste som en ljusblå ruta bakom märket. Båda
      trapporna är monotona — ett steg får aldrig färre uddar eller tunnare
      ring än steget under, annars ser klättringen ut som ett tapp.
    - Tonerna 1–9 är **befintliga palettnycklar** (`peer`, `slideAccent.*`,
      `accent`, `accentSoft`, `highlight`), så märkena byter ljust/mörkt läge
      med resten av appen. Att steg 1–2 är gröna är ett medvetet undantag från
      grönregeln ovan — se den.
    - **Steg 6 läser `slideAccent.violet` och inte `community`, och det är en
      rättad bugg.** Det lånade stödets kulör, vilket gick bra så länge den var
      lila — men `community` är varm kakao sedan Friends-rummet blev varmt, och
      då la stegen ett **brunt** steg mellan ljusblått och orkidé. Spektrumet
      är det stegen är byggda av, så ett steg får inte byta familj för att en
      annan funktion bytt färg. Lån av en rollnyckel som kan tänkas byta kulör
      hör inte hemma här: ta en `slideAccent`, som bara betyder "den här
      sidans färg".
    - **Regnbågen på steg 10 är det enda som inte är palettstyrt.** Dess åtta
      kulörer är hårdkodade och temaoberoende, för en regnbåge är samma
      regnbåge mot vilken botten som helst. Den ritas av två runda `View`-ar
      med fyra olika `border*Color` var, den yttre vriden 45°: React Native
      byter kantfärg längs diagonalerna, så varje ring blir fyra bågar och de
      två tillsammans åtta. Samma egenhet som progressringen bygger på.
    - Låsta märken ritas i `textDisabled` men med **samma form**: man ska
      kunna se vad man är på väg mot, inte bara att något saknas.
  - **Alla tio steg är synliga, men bara nästa räknar ner.** En stege vars
    översta pinnar är dolda är ingen stege, så namn och timkrav står framme
    hela vägen upp. Nedräkningen (`23h to go`) hör däremot bara till steget
    närmast ovanför — längre upp står tröskeln ensam. Ett `1448h to go` på
    nivå tio går inte att sikta mot, och nio sådana rader i följd läser som
    en skuld i stället för som en stege.
- **Ingen cron.** `evaluate_circle_goals()` anropas från varje väg som kan
  ändra utfallet (ny paus, nytt mål, någon lämnar, någon öppnar fliken) och
  är idempotent via UNIQUE på `circle_goal_achievements` och
  `circle_level_ups`. Det är där veckoskiftet sker: första läsningen efter
  måndag 00:00 UTC promotar parkerade sänkningar.
- **Layoutspråket i fliken:** grupperat innehåll ligger i en `panel` — en yta
  med `overflow: hidden`, så att rader kan gå ända ut i kanten och avdelas med
  hårfina linjer i stället för mellanrum. Utfällningen av veckans medlemmar
  ligger **inuti** samma panel som sammanfattningen, inte som lösa kort under
  den: det var syskonkorten som fick sidan att flyta ihop. Sektioner skiljs åt
  med mycket luft (36) och håller ihop internt med lite (12) — kontrasten
  mellan de två är det som gör att ögat ser grupper.
  - **Inga kantlinjer, och ingen ruta runt heron.** Ytan skiljer sig redan
    från bakgrunden; en ram ovanpå blir en andra gräns för samma kant, och
    summan av alla sådana linjer gjorde sidan rörig. Ringen *är* formen —
    en rektangel runt en cirkel får två former att slåss om samma yta. Heron
    står fritt och får luft i stället. Av samma skäl är status och nivå
    versal accenttext, inte kapslar: en pill runt tre tecken är ännu en liten
    rektangel.
  - **Veckan (kretsens wrapped) är en rad i kretsens meny**, *This week*,
    med samma `insights`-ikon som förut. Den var en ikonknapp i rubrikraden
    och flyttade in i menyn bakom namnet på begäran (se medlemslistan
    nedan).
    - **Tvillingen i [app/stats.tsx](app/stats.tsx) är kvar som knapp**:
      44 × 44, `insights`-ikonen, ingen text, `accessibilityLabel` bär
      meningen. I statistiken var *See the week that passed* ett brett kort
      som bara sa vad knappen redan var och sköt ner `RECENT PAUSES` en hel
      radhöjd.
    - **I statistiken sitter den i högra hörnet av `RECENT PAUSES`-raden**,
      inte uppe på bakåtraden: veckan hör ihop med pauserna den
      sammanfattar, och listan under rubriken är just de pauserna. Raden
      äger rubrikens marginaler — lämnade man dem på etiketten hade en
      `marginBottom` i en `center`-justerad rad förskjutit texten uppåt mot
      knappen i stället för att skilja rubriken från listan.
- **Heron är borttagen.** Överst i fliken stod förr den egna veckan — först en
  ring, sedan två streck — i en egen pager *Your week / Your day*. Den visade
  samma person två gånger på samma skärm, för man är också ett streck i
  potten. Nu är man själv det första strecket, valt som förval, och raden
  under strecken säger ens siffror (`4h 12min this week · 34% of the pot`,
  även för den som nått sitt mål — att målet är nått syns på strecket och i
  *See everyone*). Målet ändras på Hem (`− +`) eller via den egna raden
  under *See everyone*, som öppnar ratten; saknas det står `Set your goal ›`
  på raden under strecken. Medlemskortens
  `pencil-alt` är borta av ett annat skäl — se *Att göra* nedan.
  - **Målratten går i hela timmar, med en halvtimme som första steg**
    (`GOAL_OPTIONS`: 30 min, 1–12 h — tretton detenter; taket är `set_daily_goal`s 12 h). Halvtimmessteg hela vägen
    gav tolv detenter där hälften bara var `2h 30min`-varianter av sina
    grannar: stökigt att läsa utan att bli mer användbart. Den enda
    halvtimmen som bär något är den första, för 30 min och 1 h är verkligt
    olika löften. Ett äldre mål på en halvtimmesnivå snäppar till närmaste
    hela timme nästa gång ratten öppnas och sparas — `nearestGoalIndex()`
    avrundar nedåt vid exakt lika avstånd.
  - **Men *Set your goal* står alltid synlig när inget mål finns.**
    `evaluate_circle_goals()` kräver `goals_set_count = member_count`, så en
    enda medlem utan mål blockerar veckans bedrift för *hela* kretsen. Den
    uppmaningen får inte gömmas bakom ett val — därför gäller länken under
    strecken alltid en själv, även när någon annans streck är valt.
  ([components/progress-ring.tsx](components/progress-ring.tsx) används inte
  längre av någon skärm men står kvar.) Ringen ritas utan `react-native-svg` — biblioteket finns numera, men ringen
  är en form och inte en toning, samma linje som nivåmärkena ovan:
  två halvor som klipper var sin sida, med en hel cirkel inuti
  där bara topp- och högerkanten är färgade. Den inre cirkeln är lika stor
  som ringen, så dess mittpunkt ligger på ringens mitt och rotationen sveper
  kring centrum utan `transformOrigin`.
- `circle_pause_ledger` har **inga grants** — den är råmaterialet, inte något
  klienten bläddrar i. Allt som visas kommer aggregerat ur
  `get_circle_progress()`, som också är det enda stället som läser
  medlemmarnas `pause_sessions` tvärs över RLS. `profiles.show_stats`
  ignoreras medvetet där: inne i en cirkel är din andel av ett mål ni satt
  ihop hela poängen.
- **Veckans wrapped har en sida *Longest pause*** — vem, hur länge, och
  **när** (`Saturday, 06:00 – 20:00`, eller `Fri 23:10 – Sat 08:05` över
  midnatt), i tittarens lokala tid. Det är det enda stället där en medlem ser
  en annans enskilda paus och inte bara summor, och det är valt. Den är svaret
  på frågan om en natt med en vanlig paus igång som fyller potten: en paus får
  vara hur lång som helst och räknas hela vägen — en skärmfri dag ska belönas,
  och att bära kretsen en vecka är en bra känsla — men när den låg syns för
  kretsen. Inget tak, inget nattfönster; båda övervägdes och valdes bort. Bara
  tid och längd, aldrig intentionen. Kommer ur `longest_pause` i
  `get_circle_wrapped()`.
- **Kretsens meny öppnas genom att trycka på cirkelns namn.** Rubriken *är*
  knappen, med ett `⌄` bredvid: en rubrik som går att trycka på måste visa
  att den gör det. Namnet har `numberOfLines={1}` och krymper före `⌄`.
  - **Menyn är ett ark nerifrån** (som att göra-arket och taggkortet) med
    kretsens namn, inställningsraden, medlemmarna som ansikten, *Reward*
    (bara när belöningen är på), *This week* och *Leave circle*. Den var
    medlemslistan och växte till menyn när belöningen och veckan flyttade ut
    ur rubrikraden på begäran — användare ville ha en renare sida. Rubrikraden
    bär numera bara chatten (se *Kretsens chatt*).
  - **Medlemslistan ligger ett steg in, i samma kort** (`menuPage`), med en
    bakåtknapp. Sidan byts i kortet i stället för att en modal öppnas ovanpå,
    för två modaler ovanpå varandra fungerar inte på iOS. Rader som öppnar
    ett annat ark (inställningarna, belöningen) stänger menyn först.
  - **Pricken på `⌄`** betyder att något bakom menyn väntar på en själv —
    idag bara en ej lagd röst på belöningen — och raden inne i menyn bär
    samma prick. Det är den enda prick som får gömmas bakom menyn: allt med
    en prick som används ofta (chatten) står kvar framme.
  Medlemslistan är enda
  stället där cirkeln skriver till `friendships` — samma direkta insert som
  `app/add-friend.tsx:116`, ingen RPC. Relationerna hämtas när modalen öppnas
  och inte i `load()`, som kör var fjärde sekund. En väntande förfrågan visas
  som "Pending" utan riktning med flit: den kan gå åt båda hållen, och
  "Requested" hade ljugit när det var de som frågat dig. Att svara på den hör
  hemma i vänner-fliken.
  - **Utgången, *Leave circle*, bor sist i menyn** — med en linje ovanför
    och i `danger`. Den satt förr som en ikon bredvid inbjudan i
    rubrikraden. Att lämna är sällsynt och svårt att ångra och hör hemma
    där medlemskapet syns.
  - **Inbjudan bor i medlemslistan**, som en liten rund ikon (`user-plus`,
    rummets `hue`) till höger på listans rubrikrad. Den satt ytterst
    i kretsflikens rubrikrad och flyttade när belöningen tog plats där: att
    bjuda in hör till vilka som är med. En tid var den en hel rad,
    *Invite friends*, ovanför utgången; den krymptes till en ikon på
    begäran. Full krets ger en grå ikon som inte går att trycka på, och
    *The circle is full* står i `accessibilityLabel`.
  - **Ägaren kan ta bort en medlem, och ordet är *Remove*.** Knappen är en
    ikon (`user-times`, `Palette.danger`) sist på medlemmens rad, syns bara
    för `role = 'owner'` och aldrig på den egna raden — den som vill ut
    själv använder *Leave circle*. `remove_circle_member(p_user_id)` är
    `leave_circle` sett från andra hållet och gör medvetet inget mer: samma
    `evaluate_circle_goals()` efteråt, och timmarna stannar i
    `circle_pause_ledger` av samma skäl som vid ett frivilligt utträde.
    Ingen ägarbyte-gren behövs, för ägaren är den som ropar.
    - **Flödesraden är `member_left`, alltså "Maja left the circle."** Det
      är inte hela sanningen för den borttagna, och det är priset: kretsen
      ska inte kunna läsa ut vem som tog bort vem. En egen typ
      (`member_removed`) hade sagt det rakare men också hängt ut båda — det
      valet är gjort, inte förbisett.
- **Kretsmärket på en väns profilkort** (Friends-fliken) kommer från
  `get_friend_circle_badge(p_user_id)`, inte från en vanlig select. RLS på
  `circles`/`circle_members` släpper med flit bara igenom den krets man själv
  är med i, så en vän i en *annan* krets vore annars osynlig — RPC:n kör
  `security definer` av samma skäl som `get_partner_session_status`.
  - Den lämnar ut **två saker: kretsens namn och dess nivå.** Inte medlemmar,
    inte timmar, inte mål. Nivån är kretsens gemensamma — det finns ingen
    personlig nivå i systemet, och kortet får inte antyda att det gör det.
    Därför står kretsnamnet överst och nivån under som dess egenskap.
  - Kräver en vänskapsrad åt något håll, **oavsett status**: kortet öppnas
    både för accepterade vänner och för inkommande förfrågningar, och den som
    frågar om att få lägga till dig ska kunna visa vilken krets hen hör till.
  - `null` betyder både "ingen krets" och "inte vänner", och kortet skiljer
    inte på dem — ett "hen är med i en krets men du får inte se vilken" vore
    att läcka just det som inte lämnas ut. Raden uteblir helt.
  - **`profiles.show_stats` gäller inte här.** Den flaggan styr pausaktivitet
    (senaste pausen, wrapped-knappen), står `false` som förval, och en
    kretstillhörighet är hemvist snarare än statistik — att gömma den bakom
    en flagga som nästan ingen slagit på hade gjort funktionen osynlig.
    Skulle den behöva kunna döljas krävs en egen flagga.
  - Hämtas när kortet öppnas, inte i listans `load()`: listan ritar upp till
    åtta rader, och åtta RPC-anrop för något som syns först vid ett tryck är
    åtta för mycket. Samma skäl som medlemslistan i Kretsen har.
- **Aktivitetsflödet** (`circle_activity`) sparar bara `type` + `metadata`,
  aldrig färdig engelsk text — texten byggs client-side av
  `formatActivity()` i [lib/circles.ts](lib/circles.ts), samma princip som
  `my-wrapped.tsx`/`friend-wrapped.tsx` redan använder för sin statistik.
  `recordPauseInCircle()` i samma fil anropas efter varje avslutad paus
  (både det lådlösa flödet i `app/pausing.tsx` och lådflödets
  `lib/sessionOutbox.ts`) och no-opar tyst om användaren inte är med i
  någon cirkel. Den skickar bara sessionens id — RPC:n läser längd och
  sluttid ur `pause_sessions` själv, så ingen kan skriva in timmar som inte
  finns i den egna loggen, och dedupen på `session_id` gör den ofarlig att
  anropa om när outboxen skickar om en köad låd-session.
  - **Tio rader, sedan en utfällning.** `load()` hämtar 50 rader men flödet
    visar `ACTIVITY_PREVIEW` (10) tills man trycker *Show more*. Foten är
    samma `panelFoot` som veckopanelens *See everyone* — två utfällningar på
    samma flik ska inte se ut som två olika sorters knapp — och renderas bara
    när det faktiskt finns fler rader än så. Taket på 50 är fortfarande
    hämtningens, inte utfällningens: *Show more* visar det som redan är
    laddat och frågar inte servern om mer.

### Flera kretsar

**Man kan vara med i upp till tre kretsar** (`circle_max_per_user()` i
[supabase/circles.sql](supabase/circles.sql), speglat av
`CIRCLE_MAX_PER_USER` i [lib/circles.ts](lib/circles.ts) — de två måste
stämma). `circle_members.user_id` är inte längre `UNIQUE`; paret
`(circle_id, user_id)` är det, och taket sitter i `create_circle` och
`accept_circle_invite`.

- **En paus räknas i varje krets man är med i.** `record_circle_pause`
  loopar över ens kretsar och skriver en ledgerrad och en flödesrad i var och
  en; dubblettskyddet är `(circle_id, session_id)`. Att välja krets per paus
  hade varit ett beslut efter varje paus, och det här går att säga på en rad —
  vilket `+`-vyn gör: *Every pause you take counts in all of them, and your
  daily goal is the same in each.*
- **Dagsmålet är ett.** Det bor på `profiles`; `set_daily_goal` loggar
  ändringen i varje krets flöde och utvärderar varje vecka. Samma sak gäller
  en avbockad att göra-punkt (`complete_wishlist_item`).
- **RPC:erna tar `p_circle_id`**, med `null` som förval. `null` betyder den
  krets man gick med i först (`resolve_my_circle`), så att en äldre app som
  inte skickar något id fungerar för den som bara har en. Ny kod skickar
  **alltid** id:t: `get_circle_progress`, `get_circle_wrapped`,
  `toggle_wrapped_heart`, `leave_circle`, `remove_circle_member`,
  `send_circle_message`, `mark_circle_chat_read`, `get_circle_reward`,
  `get_circle_reward_history`, `propose_circle_reward`. En röst eller ett
  tillbakadraget förslag bär sin krets genom förslagets id.
- **Kretsraden överst i fliken är kapslar** (`CircleSwitcher` i
  [app/(tabs)/circle.tsx](app/(tabs)/circle.tsx)): en per krets och ett
  `+` så länge det finns plats, i sidled rullbar. Den står där också med en
  enda krets, så att det syns att det går att ha fler. Den valda fylls i
  rummets `hue` (kapseln är ett val, samma undantag och textregel som
  periodvalet); en prick på en annan krets betyder olästa i dess chatt, och
  på `+` en inbjudan man har plats för.
  - **Under kapslarna står den valda kretsens namn som rubrik**
    (`CircleTitle`), och ett tryck på den öppnar medlemslistan direkt.
    Namnet står alltså två gånger — i kapseln och i rubriken — och det är
    priset. Nivån och kretsens tre knappar står på raden under.
  - **Kapslarna togs tillbaka på begäran.** Däremellan var rubriken ett
    namn med `⌄` som öppnade en väljare (`CirclePicker`: kretsarna,
    *Members of …*, *Join or start another circle*); den är borttagen. En
    version med namnen som rubrik och de andra kretsarna bredvid i mindre
    grå text valdes också bort.
  - `+` visar samma *skapa eller tacka ja* som tomvyn (`JoinOrCreate`), med
    rubriken *Another circle*.
  - Med tre kretsar finns inget `+`, och en rad under kapslarna säger att en
    inbjudan väntar och att man måste lämna en krets.
- **Vilken krets fliken visar** sparas per enhet (`getSelectedCircleId`),
  och faller tillbaka på den första om man lämnat den. En nyss skapad krets
  väljs genom `requestCircleSelection` (fliken avmonteras inte och har sitt
  val i minnet), en nyss accepterad direkt i `handleAcceptInvite`.
  `load()` kastar sitt svar om valet ändrats medan det var på väg.
- **Hem läser inte längre kretsen** — se Dagsmålet. Kretsen avgör bara om
  *Set a daily goal* syns.
- **Vänkortet** visar alla en väns kretsar (`get_friend_circle_badge` har
  numera en lista `circles`); med en krets ser kortet ut som förut.
- **Chattnotisen döljs bara för den chatt som står framme**:
  `setChatScreenOpen(circleId)` jämförs med notisens `circle_id`.
- **Körordning:** circles.sql, sedan circle_chat.sql, circle_rewards.sql,
  circle_goal_notify.sql och wishlist.sql. Kör SQL:en **före** appen: den
  nya klienten skickar `p_circle_id`, som en gammal databas inte känner.

### Kretsens inställningar

Ägaren gör två val när kretsen skapas (sista steget i
[app/circle-create.tsx](app/circle-create.tsx)) och kan ändra dem från
raden överst i medlemslistan. Kolumnerna och reglerna står i
[supabase/circles.sql](supabase/circles.sql) under *Kretsens inställningar*,
formuläret i [components/circle-settings-form.tsx](components/circle-settings-form.tsx)
(delat av båda ställena), rutan i [components/circle-settings-sheet.tsx](components/circle-settings-sheet.tsx).
Sparningen går genom `set_circle_settings`, som bara ägaren får anropa.

- **Det är ägarens, och det är inte en motsägelse.** Ägaren har ingen
  särskild makt över kretsens *innehåll* (belöningsförslag, chatten), men
  hur kretsen räknar är en inställning, och någon måste kunna välja den
  innan det finns fler än en medlem.
- **Belöningen är valfri, och av som förval** (`rewards_enabled`). En fika
  varje vunnen vecka blir för mycket för många grupper. Av döljer kransen i
  rubriken; historiken står kvar. Se *Kretsens belöning*.
- **Räknefönstret** avgör vilka timmar och dagar en paus räknas i potten:
  hela timmar (`count_from`/`count_to`, båda null = dygnet runt) i varje
  medlems **egen** tid, och `count_workdays` för måndag–fredag.
  - **Det tillämpas när pausen skrivs**, i `record_circle_pause` via
    `circle_counted_seconds`: en paus 16:30–17:30 med fönster till 17 ger
    halva sin längd, och en paus helt utanför ger ingen ledgerrad och ingen
    flödesrad i den kretsen. Raden ändras aldrig efteråt, så stegen och
    historiken skrivs inte om när fönstret ändras. Därför skickar klienten
    `p_tz_offset_minutes` med varje paus.
  - **Veckans ribba är dagsmålet × antal räknade dagar**
    (`circle_count_days()`: 5 eller 7) — i `evaluate_circle_goals`,
    `get_circle_progress` och `get_circle_wrapped`. Utan det kunde en
    arbetsplats aldrig vinna en vecka. Klienten räknar inte ribban själv
    någonstans; den läser `target_seconds`.
  - **En ändring gäller från nästa måndag** (`pending_count_*`, flyttas fram
    av `promote_circle_settings()` vid veckoskiftet), utom under kretsens
    första vecka. Rutan säger det efter sparningen, och medlemslistan visar
    *From next week: …* tills dess.
  - **Hem påverkas inte.** Ringen där räknar alltid ens egna pauser dygnet
    runt. Formuläret säger bara *Only pauses in this time window go into the
    shared pot.* En andra mening om att alla pauser ändå räknas för en själv
    prövades och förvirrade mer än den lugnade.
  - **Circle-vyn visar bara datumen som räknas.** Datumraden under
    kapseln är bara datum, och med `count_workdays` slutar veckan på
    fredagen (*OCT 5 – OCT 9*). Den visade förr hela inställningen
    (*· 8–17, MON–FRI*), och det var för mycket; inställningen i ord står
    i medlemslistans rad. En statusrad ovanför kapseln (*COUNTING NOW ·
    UNTIL 17:00* / *NOT COUNTING · STARTS MON 8:00*) prövades och togs
    bort som onödig.
- **Körordning:** circles.sql före circle_rewards.sql — belöningens SQL
  läser `circles.rewards_enabled`.

### Kretsens chatt

Ett rum för de 2–10 personerna i en krets. Schemat bor i
[supabase/circle_chat.sql](supabase/circle_chat.sql) (körs för hand i
SQL-editorn efter `circles.sql`, samma konvention som resten), vägen dit i
[lib/circleChat.ts](lib/circleChat.ts), och skärmen i
[app/circle-chat.tsx](app/circle-chat.tsx).

- **Chatten knackar en gång per oläst svit**, inte en gång per meddelande —
  se *De sociala notiserna*. Den var länge avfärdad för att en chattnotis har
  ett tak som sätts av hur mycket de andra skriver; taket sitter nu i hur
  ofta man själv läser, och det var det som gjorde den möjlig. Notisen säger
  vem som skrev och aldrig vad. Pricken på chattikonen står kvar: notisen
  säger *att* något sagts, pricken *var*. (Tomvyns rad om att chatten är tyst
  är borttagen — den är inte sann längre.)
- **Egen skärm, inte en panel i fliken.** Ett samtal behöver hela höjden och
  en skrivrad som följer tangentbordet. Inne i kretsflikens rullning hade
  den slagits med potten och flödet om samma lodräta utrymme, och skrivraden
  hamnat under tangentbordet längst ner i en lång sida.
- **Ingången är den enda knappen kvar i rubrikraden (`headerActions`)**, till
  höger om nivån under kretsens namn. Raden bar en gång fyra ikoner och
  sedan tre (belöningen, veckan, chatten); belöningen och veckan flyttade in
  i kretsens meny bakom namnet på begäran, för att sidan skulle bli renare.
  Chatten stannade framme för att den används oftast och för att dess prick
  måste synas — en prick bakom en meny blir en prick på menyn, och då säger
  den inte längre *vad*. Knapparna har vandrat: en stapel bredvid
  nivåmärket, en kolumn bredvid pottens streck, och nu en rad till höger om
  nivån. Samma rad som namnet prövades och flyttades tillbaka: namnet fick
  för lite plats.
  - Samma kvadrat, radie och ram som veckoknappen i stats.tsx.
  - Ikonen är en **fylld** bubbla (`comment` med `solid`): den ska hittas
    utan att man letar, och en kontur försvinner bland kretsflikens
    hårfina linjer.
  - Pricken är allt som säger att något är osagt — ingen siffra, för
    antalet olästa är inte en uppgift man ska förhålla sig till. Den ligger
    **innanför** knappens kant: Android klipper absolut placerade barn mot
    en förälder med `borderRadius`, så ett negativt `top`/`right` hade gett
    en prick som syns på iOS och saknas på Android.
- **Klockslaget står utanför bubblan, till vänster om den, i grått.** Inne i
  bubblan delade det utrymme med texten och tvingade fram en luftrad under
  varje kort meddelande. Som egen kolumn i en `flex-end`-rad står siffran i
  linje med bubblans nederkant utan att trycka ihop orden, och den behöver
  inte längre två färger — `onAccent` gällde bara så länge den låg ovanpå
  den fyllda blå. Bubblans `maxWidth` är därför 70 % och inte 78: siffran
  och avataren tar sin bredd ur samma rad.
- **Chatten ligger inte i aktivitetsflödet, och ska inte läggas där.**
  `circle_activity` är till för det som *hänt* (pauser, mål, nivåer). Ett
  samtal som dubbleras rad för rad där begraver milstolparna flödet finns
  för att visa. `send_circle_message` loggar därför med flit ingenting.
- **Läsning direkt mot tabellen, skrivning genom RPC** — samma uppdelning
  som resten av kretsarnas tabeller. `circle_messages` har bara
  `grant select`, så ingen kan skriva i någon annans namn eller i en krets
  hen inte är med i, och trimningen plus 500-teckenstaket sitter i
  `send_circle_message` och inte bara i `TextInput`s `maxLength`.
- **Bara sitt eget går att radera, också för ägaren.** Att kunna ta bort
  någon annans ord ur ett rum med fyra personer är en helt annan sak än att
  ta bort en medlem, och den makten hör inte till rollen.
- **Hela historiken är synlig för varje medlem, också den som just gått
  med.** En chatt som börjar tom för nykomlingen läser som en bugg ("vart
  tog samtalet vägen?"), och kretsen är en liten grupp vänner snarare än ett
  forum. Priset — att det som sagts innan man kom är läsbart efteråt — är
  valt. Olästräknaren utgår däremot från `joined_at` för den som aldrig
  läst, så ingen möts av en prick för tvåhundra gamla rader.
- **`chat_read_at` bor på `circle_members`**, inte i en egen tabell: det
  finns exakt ett tal per person och krets, samma par som medlemsraden. Att
  läsa i en krets chatt släcker inte pricken i en annan. Läsmärket flyttas fram när skärmen öppnas, när ett nytt
  meddelande landar medan den är öppen, och av `send_circle_message` — den
  som skriver har läst allt ovanför.
- **`circle_messages` ligger i publikationen `supabase_realtime`**, till
  skillnad från `profiles`. Skillnaden är RLS: den är **på** här, så en
  prenumerant får bara rader ur sin egen krets — det var just avsaknaden av
  RLS som höll `profiles` utanför. Klienten pollar ändå var fjärde sekund
  (samma par som kretsfliken), så en databas där `alter publication` inte
  gick igenom blir långsam och inte trasig.
- **Sidan om är 40 rader, och början nås en gång.** `reachedStart` sätts när
  en bakåtbläddring kom tillbaka med mindre än en hel sida. Det är ett eget
  tillstånd och inte ett `hasMore` som pollen räknar om: pollen hämtar
  alltid den *senaste* sidan, och skulle den få räkna om talet vore svaret
  alltid "en hel sida, alltså finns det mer" — och *Load earlier* kom
  tillbaka varje gång man nått början. Bakåtbläddringen ankras på
  `created_at` och inte på ett offset, för ett nytt meddelande mellan två
  hämtningar hade förskjutit offseten och hoppat över en rad.
- **Pollens sammanfogning är inte ett rent tillägg.** Allt lokalt inom den
  hämtade sidans tidsfönster kastas och ersätts av svaret — det är så en
  radering syns. En radering längre bak än den senaste sidan syns först
  nästa gång chatten öppnas, och det är accepterat.
- `user_id` är `on delete set null`, precis som `circle_activity.actor_id`:
  ett raderat konto ska inte radera halva samtalet för de som är kvar.
  Raden renderas som "Someone".

### Kretsens belöning

Det kretsen gör ihop när veckans bedrift är låst — *AW på torsdag*, *vi
slutar en timme tidigare på fredag*, *fika*. Texten är gruppens egen, och
appen kan inte kontrollera att den blir av och försöker inte. Schemat bor i
[supabase/circle_rewards.sql](supabase/circle_rewards.sql) (körs för hand
efter `circles.sql`), klienten i [lib/circleRewards.ts](lib/circleRewards.ts),
modalen i [components/circle-reward-sheet.tsx](components/circle-reward-sheet.tsx).

- **En belöning i taget, och den står bakom en rad i kretsens meny, inte på
  sidan.** Raden bär en stjärna i en lagerkrans
  ([components/reward-wreath-icon.tsx](components/reward-wreath-icon.tsx),
  svg, eftersom en krans är blad längs en båge och inte går att bygga av
  kanter), fylld när kretsen har en belöning, och belöningens text till
  höger. Kransen stod förr först i rubrikraden och flyttade in i menyn på
  begäran. Plottret uppstår när flera saker står framme samtidigt, så
  ingenting om belöningen står framme.
- **Den är valfri per krets, och av som förval** (`circles.rewards_enabled`,
  ägarens val — se *Kretsens inställningar*). Av: ingen krans i rubriken,
  `propose_circle_reward` tar inte emot förslag, triggern låser ingenting,
  och `get_circle_reward` svarar med `enabled: false`. Historiken står kvar.
- **Belöningen är förslaget med flest ja — ingen gräns att nå.** Vid lika
  vinner det som föreslogs först. En första version krävde mer än hälften av
  kretsen och antog då förslaget; det gjorde att ett förslag med flest röster
  ändå inte gällde, och det gick inte att förklara utan ett `2 of 3` på
  raden. Nu räknas ledaren fram vid varje läsning (`circle_reward_leader`,
  den enda platsen regeln finns) och kan alltså byta medan veckan pågår.
- **En röst per person, och inte på sitt eget** (unikt index på
  `(circle_id, user_id)` i `circle_reward_votes`). Ett nytt ja flyttar
  rösten; ett tryck där den redan ligger tar tillbaka den. Fick man rösta på
  sitt eget gjorde alla det, allt blev lika, och bara vem som var först
  avgjorde.
- **Alla får föreslå, och ägaren har ingen särskild makt** — samma linje som
  att ägaren inte kan radera andras chattmeddelanden. Var och en har högst
  **ett** förslag (unikt index; ett nytt ersätter ens gamla, och dess röster
  följer inte med).
- **Allt börjar om varje måndag.** Förslag och röster bär `week_start`
  (samma måndag 00:00 UTC som potten), och allt som läses och skrivs gäller
  den pågående veckan. Utan det kunde röster från för en månad sedan avgöra
  den här veckans belöning, och datumen i modalens hörn hade inte stämt.
  Priset är att en krets som vill ha samma belöning varje vecka får föreslå
  den igen — det är också veckans lilla ritual. Gamla veckors rader står
  kvar men läses inte.
- **Skyddet mot trams är tre tak, ingen moderering.** Ett förslag blir
  belöningen först när **någon annan** sagt ja till det, så ingen kan göra
  sin egen text till kretsens. Ett förslag per person och vecka, så ingen
  kan spamma. Och veckan nollställs, så det ingen ville ha är borta på
  måndag. (En sjudagarsgräns för förslag utan röster, `expires_at`, fanns
  före veckan och läses inte längre.)
- **Det finns inget nej.** Ingen ska behöva rösta emot en kompis idé — man
  lägger sin röst på något annat.
- **Det är inte omröstningen som revs.** `circle_goal_proposals` var en
  röstning om ett *tal* någon annan skulle leva upp till, och fritexten
  `group_goal` var något ingenting läste och vem som helst kunde skriva
  över. En belöning är inget krav på någon, den hänger på
  `circle_goal_achievements`, och den byts bara genom röster.
- **Veckans belöning fryses när veckan låses**, av triggern
  `circle_goal_lock_reward` på `circle_goal_achievements` (en trigger så att
  circles.sql inte behöver röras, på samma insert som redan är veckans
  engångshändelse). Ledaren i det ögonblicket skrivs till
  `circle_reward_unlocks` och kan inte röstas bort i efterhand. Triggern har
  ett `exception when others`: en belöning som inte gick att låsa får aldrig
  fälla veckans bedrift.
- **Städningen sker i SQL, utan cron** (`settle_circle_rewards`, samma
  linje som `evaluate_circle_goals`), före varje läsning och förslag: den som
  lämnat tar med sig sitt förslag och sin röst.
- **Pricken** (på menyns rad och på `⌄` bredvid kretsens namn) betyder att man inte lagt sin röst än och att det
  finns andras förslag att lägga den på. När rösten väl ligger någonstans
  väntar ingenting, hur många förslag som än kommer till. Ingen siffra, och
  den räknas **inte** in i flikbrickan.
- **Ingen notis.** Antalet förslag och röster beror på hur aktiva andra är
  — se notisavsnittet högst upp.
- **Flödet får en rad bara när veckan låses** (`reward_unlocked`, *Reward
  unlocked: fika*, utan aktör). Inte när ledaren byter — den kan byta fram
  och tillbaka, och varje byte vore brus. `reward_adopted` är kvar i
  formateringen för rader från första versionen.
- **Modalen är tre saker och inget mer:** belöningen stort med en rad under
  (*When everyone hits their goal* / *Unlocked this week*), förslagen som
  rader där hela raden är knappen (en ring som fylls där ens röst ligger; på ens eget
  ett rött kryss, `danger`, som tar bort det efter en fråga), och en skrivrad med en pil som
  chattens. Ingen titel, inga sektionsrubriker, ingen stängknapp (tryck
  utanför). En första version hade en tonad ruta, etiketter, *SUGGESTIONS*,
  dagar kvar och en stor knapp, och lästes som ett formulär. Lägg inte
  tillbaka dem.
  - **Reglerna står bakom ett frågetecken** i kortets övre högra hörn, och
    bara där (`HOW_IT_WORKS`): flest röster vinner och äldst vid lika, en
    röst och inte på sitt eget, upplåst när veckan vinns, ett förslag var och
    omstart varje måndag. Rutan *ersätter* kortets innehåll i stället för
    att läggas över det — ett kort utan förslag är lägre än texten. Ändras
    en regel i SQL ska raden ändras där.
  - **Veckans datum står mellan kransen och belöningen**, i samma form som
    kretsflikens datumrad (`formatWeekRange`, *OCT 5 – OCT 11*), så att de
    två läses som samma vecka. De stod en tid ensamma uppe till vänster och
    läste som en etikett utan ägare; direkt ovanför belöningen säger de
    vilken vecka den gäller.
  - **Historiken står bakom vänstra hörnknappen** (en klocka, tvilling till
    frågetecknet), och byter kortets innehåll på samma sätt som reglerna.
    **Bara de vunna veckorna**, senaste först, högst 52
    (`get_circle_reward_history`): en stjärna i rummets kulör, den upplåsta
    belöningen, och datumen med månad (`formatWeekSpan`, *Sep 28 – Oct 4* —
    i gemener, och samma månad skrivs en gång). Det är ett ställe
    att fira, inte ett protokoll. En första version visade varje vecka sedan
    kretsen skapades, med tomma stjärnor och nedtonade förslag för de
    missade; det valdes bort på begäran, och de missade syns ändå i potten
    och i veckans wrapped. Hämtas när den öppnas, inte i fliken var fjärde
    sekund.
  - **Rösterna är bara antalet ja**, en siffra framför ringen. `2 of 3` och
    sedan prickar per behövt ja prövades och var båda för plottriga. Listan
    kommer sorterad ur SQL (flest först, äldst först vid lika), så översta
    raden med ett ja är belöningen, och dess siffra står i rummets kulör.
  - **En vunnen vecka gör belöningen till ett pris:** ett kort i rummets
    kulör med en radiell glöd bakom en större krans, och förslagen under
    tonas till 40 %. De går fortfarande att trycka på — de gäller nästa
    belöning — men de är bakgrund. Glöden är en svg-toning; en platt cirkel
    lästes som en skiva.
- Texten är högst 80 tecken, trimmad i RPC:n och inte bara i `maxLength`.
