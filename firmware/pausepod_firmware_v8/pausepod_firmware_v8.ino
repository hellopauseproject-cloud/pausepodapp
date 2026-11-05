// Pause Pod — firmware v8
// v7 + NFC-taggen + WiFi. Tumplattorna är borta.
//
// TVÅ SÄTT ATT STARTA EN PAUS
//
// 1. Lådan själv (NFC). Telefonen med sin registrerade Pause-tagg läggs i
//    lådan → displayen säger HI, <NAMN> → locket stängs → pausen startar
//    (bocken → CLOCK ON. → 00:01–00:05 → märket). Ingen app behövs.
//    Okänd tagg → QR-koden för registrering, som i pause_pod_nfc.
//    Pausen sparas av lådan själv via WiFi (edge-funktionen box-session),
//    också när appen är stängd.
//
// 2. Appen (Bluetooth), som i v7. set_mode → PLACE PHONE IN BOX → phone_down
//    → CLOSE BOX → locket stängs → pausen startar. Utan tummar skickas
//    checkin_complete och session_started i samma stund som locket stängs.
//    Pausen går till appen via Bluetooth som förut (session_ended + ack).
//
// UT
//
//    Locket öppnas → klockan fryser, ON HOLD, ringen krymper i 30 s.
//    Stängs locket igen fortsätter pausen.
//    NFC-paus: taggen borta (telefonen lyft) → pausen klar, completed=1.
//    App-paus: appens phone_up → pausen klar, completed=1 (som v7).
//    Rinner fristen ut avslutas den ändå, completed=0.
//
// Varje paus går bara EN väg: en NFC-paus skickas aldrig över Bluetooth
// (då hade appen sparat den en gång till), och en app-paus aldrig över WiFi.
//
// ÄNDRAT MOT v7:
//  - Tumplattorna, STATS-sidorna och SHOWING_TIME är borta. Pinnarna 2 och 3
//    är lediga.
//  - RC522-läsaren på SPI (SDA 10, SCK 12, MOSI 11, MISO 13, RST 16).
//    RST låg på GPIO 1 i NFC-testet — där sitter magnetsensorn. FLYTTA RST
//    till GPIO 16 (eller koppla den till 3.3V och sätt RC522_RST_PIN till
//    UINT8_MAX nedan).
//  - WiFi och allt nätverk körs i en egen task, så att skärmen, locket och
//    Bluetooth aldrig fryser medan lådan väntar på servern.
//  - Skärmbufferten (108 kB) läggs i PSRAM: Verktyg → PSRAM: "OPI PSRAM"
//    måste vara på, annars räcker inte minnet till Bluetooth + WiFi + TLS.

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
// WebServer före TFT_eSPI: TFT_eSPI läser FS.h med FS_NO_GLOBALS, och då
// hittar WebServer inte FS om den kommer efter.
#include <WebServer.h>
#include <DNSServer.h>
#include <TFT_eSPI.h>
#include <Preferences.h>
#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <stdarg.h>
#include "esp_sleep.h"
#include <sys/time.h>
#include "driver/rtc_io.h"
#include "qrcode.h"
#include "pausepod_types.h"
#include "secrets.h"

// ─── Egna typer ─────────────────────────────────────────────
// Står överst med flit: Arduino lägger in en deklaration av varje funktion
// före den första funktionen i filen, och en deklaration som nämner en typ
// som inte finns än ger "does not name a type".

// Vem äger pausen
enum Owner : uint8_t { OWNER_NONE = 0, OWNER_APP = 1, OWNER_TAG = 2 };

// WiFi-kön: NFC-pauser som väntar på servern. Egen struct — SessionRecord i
// pausepod_types.h lagras redan i NVS och dess layout får inte ändras.
struct WifiRecord {
  uint32_t      seq;
  uint32_t      durationMs;
  unsigned long endedAtMillis;   // 0 = okänd (återställd ur checkpoint)
  uint8_t       completed;
  char          tagUid[21];
};

// Vad servern sa om taggen som ligger i lådan
enum TagInfo : uint8_t { TI_NONE, TI_PENDING, TI_KNOWN, TI_UNKNOWN, TI_OFFLINE };

// ─── Hårdvara ───────────────────────────────────────────────

#define LID_PIN         1
#define POWER_PIN        15
#define BATTERY_ADC_PIN  4

#define RC522_SS_PIN     10
#define RC522_SCK_PIN    12
#define RC522_MOSI_PIN   11
#define RC522_MISO_PIN   13
#define RC522_RST_PIN    16

#define SERVICE_UUID        "12345678-1234-1234-1234-123456789012"
#define CHARACTERISTIC_UUID "abcdefab-cdef-abcd-efab-cdefabcdefab"

const char* PAIR_URL_FALLBACK = "https://joinpausepod.com/pair";

// ─── Beteendekonstanter ─────────────────────────────────────

const unsigned long PHONE_WAIT_MAX_MS   = 20000;  // appen tyst så länge → visa CLOSE BOX ändå
const unsigned long AWAIT_LID_MAX_MS    = 90000;  // ingen stänger locket → tillbaka till loggan

// Startceremonin, segment för segment
const unsigned long CHECK_DRAW_MS       = 400;
const unsigned long CHECK_HOLD_MS       = 400;
const unsigned long CHECK_FADE_MS       = 200;
const unsigned long STARTED_TEXT_MS     = 900;
const int           COUNT_SECONDS       = 5;
const unsigned long COUNT_FADE_MS       = 700;
const unsigned long LOGO_FADE_MS        = 1000;

const unsigned long CER_CHECK_END = CHECK_DRAW_MS + CHECK_HOLD_MS;
const unsigned long CER_TEXT_END  = CER_CHECK_END + STARTED_TEXT_MS;
const unsigned long CER_COUNT_END = CER_TEXT_END + COUNT_SECONDS * 1000UL;
const unsigned long CER_FADE_END  = CER_COUNT_END + COUNT_FADE_MS;
const unsigned long CER_END       = CER_FADE_END + LOGO_FADE_MS;
const unsigned long RESPITE_MS          = 30000;
const unsigned long MIN_SESSION_MS      = 5000;   // TESTVÄRDE — sätt 60000 innan skarp drift
const unsigned long ENDED_SHOW_MS       = 5000;
const unsigned long CHECKPOINT_MS       = 600000;
const unsigned long ACK_TIMEOUT_MS      = 3000;
const unsigned long BATTERY_REPORT_MS   = 300000;
const unsigned long BACKLOG_START_MS    = 800;
const unsigned long HANDSHAKE_DELAY_MS  = 600;
const unsigned long HEAP_LOG_MS         = 30000;
const unsigned long DEBOUNCE_MS         = 40;
const int           QUEUE_SIZE          = 50;

// NFC
const unsigned long TAG_POLL_MS         = 150;    // hur ofta läsaren frågas
const unsigned long TAG_GONE_MS         = 1500;   // så länge utan läsning = taggen borta
const unsigned long READER_CHECK_MS     = 5000;   // självkontroll av läsaren
const unsigned long PAIR_POLL_MS        = 3000;   // QR visas: fråga servern så här ofta
const unsigned long LOOKUP_RETRY_MS     = 5000;   // nätet nere: försök igen
const unsigned long UPLOAD_RETRY_MS     = 30000;  // misslyckad uppladdning: vänta
const int           WIFI_QUEUE_SIZE     = 20;

// ─── Ljud ───────────────────────────────────────────────────

void playStartTone()   { /* TODO: MAX98357A */ }
void playEndTone()     { /* TODO: MAX98357A */ }

// ─── Vem äger pausen ────────────────────────────────────────

Owner sessionOwner = OWNER_NONE;
char  sessionTagUid[21] = "";

// ─── Beständig lagring ──────────────────────────────────────

Preferences prefs;

// Bluetooth-kön, som v7: app-pauser som väntar på appens ack.
SessionRecord queueBuf[QUEUE_SIZE];
int      queueCount = 0;
uint32_t nextSeq    = 1;
String   boxIdBle   = "";   // v7:s chip-id, det appen känner lådan som över Bluetooth

WifiRecord wifiQueue[WIFI_QUEUE_SIZE];
int        wifiQueueCount = 0;

uint64_t statTotalMs   = 0;
uint32_t statLongestMs = 0;
uint32_t statLatestMs  = 0;
uint32_t statCount     = 0;

void loadPersisted() {
  prefs.begin("pausepod", false);

  boxIdBle = prefs.getString("box_id", "");
  if (boxIdBle.length() == 0) {
    uint64_t chipId = ESP.getEfuseMac();
    char buf[16];
    sprintf(buf, "%04X%08X", (uint16_t)(chipId >> 32), (uint32_t)chipId);
    boxIdBle = String(buf);
    prefs.putString("box_id", boxIdBle);
  }

  nextSeq       = prefs.getUInt("next_seq", 1);
  statTotalMs   = prefs.getULong64("total_ms", 0);
  statLongestMs = prefs.getUInt("longest_ms", 0);
  statLatestMs  = prefs.getUInt("latest_ms", 0);
  statCount     = prefs.getUInt("count", 0);

  queueCount = prefs.getInt("q_count", 0);
  if (queueCount > QUEUE_SIZE || queueCount < 0) queueCount = 0;
  if (queueCount > 0) {
    prefs.getBytes("q_data", queueBuf, sizeof(SessionRecord) * queueCount);
  }

  wifiQueueCount = prefs.getInt("wq_count", 0);
  if (wifiQueueCount > WIFI_QUEUE_SIZE || wifiQueueCount < 0) wifiQueueCount = 0;
  if (wifiQueueCount > 0) {
    prefs.getBytes("wq_data", wifiQueue, sizeof(WifiRecord) * wifiQueueCount);
    // millis() började om vid omstarten — sluttiden är inte längre känd.
    for (int i = 0; i < wifiQueueCount; i++) wifiQueue[i].endedAtMillis = 0;
  }
}

void saveQueue() {
  prefs.putInt("q_count", queueCount);
  if (queueCount > 0) prefs.putBytes("q_data", queueBuf, sizeof(SessionRecord) * queueCount);
}

void saveWifiQueue() {
  prefs.putInt("wq_count", wifiQueueCount);
  if (wifiQueueCount > 0) prefs.putBytes("wq_data", wifiQueue, sizeof(WifiRecord) * wifiQueueCount);
}

void saveStats() {
  prefs.putULong64("total_ms", statTotalMs);
  prefs.putUInt("longest_ms", statLongestMs);
  prefs.putUInt("latest_ms", statLatestMs);
  prefs.putUInt("count", statCount);
}

void queuePush(SessionRecord r) {
  if (queueCount >= QUEUE_SIZE) {
    for (int i = 1; i < QUEUE_SIZE; i++) queueBuf[i - 1] = queueBuf[i];
    queueCount = QUEUE_SIZE - 1;
  }
  queueBuf[queueCount++] = r;
  saveQueue();
}

void queueRemoveSeq(uint32_t seq) {
  int w = 0;
  for (int i = 0; i < queueCount; i++) {
    if (queueBuf[i].seq != seq) queueBuf[w++] = queueBuf[i];
  }
  if (w == queueCount) return;
  queueCount = w;
  saveQueue();
}

void wifiQueuePush(const WifiRecord& r) {
  if (wifiQueueCount >= WIFI_QUEUE_SIZE) {
    for (int i = 1; i < WIFI_QUEUE_SIZE; i++) wifiQueue[i - 1] = wifiQueue[i];
    wifiQueueCount = WIFI_QUEUE_SIZE - 1;
  }
  wifiQueue[wifiQueueCount++] = r;
  saveWifiQueue();
}

void wifiQueueRemoveSeq(uint32_t seq) {
  int w = 0;
  for (int i = 0; i < wifiQueueCount; i++) {
    if (wifiQueue[i].seq != seq) wifiQueue[w++] = wifiQueue[i];
  }
  if (w == wifiQueueCount) return;
  wifiQueueCount = w;
  saveWifiQueue();
}

// ─── BLE ────────────────────────────────────────────────────

BLECharacteristic* pCharacteristic;
bool deviceConnected     = false;
bool lastDeviceConnected = false;

static portMUX_TYPE bleValueMux = portMUX_INITIALIZER_UNLOCKED;

bool          backlogSending    = false;
uint32_t      backlogAwaitSeq   = 0;
unsigned long backlogSentAt     = 0;
unsigned long backlogStartAt    = 0;
unsigned long handshakeAt       = 0;
unsigned long lastBatteryReport = 0;

volatile uint32_t pendingAckSeq = 0;
volatile bool     pendingPhoneDown = false;
volatile bool     pendingSetMode   = false;
volatile bool     pendingPhoneUp   = false;

bool phonePlaced = false;

void sendBLE(const char* fmt, ...) {
  if (!deviceConnected) return;
  char buf[96];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  portENTER_CRITICAL(&bleValueMux);
  pCharacteristic->setValue((uint8_t*)buf, strlen(buf));
  pCharacteristic->notify();
  portEXIT_CRITICAL(&bleValueMux);
  Serial.printf("→ %s\n", buf);
}

// ─── Tillstånd ──────────────────────────────────────────────

Phase phase = IDLE;

// Det appen får veta om lådans fas. En NFC-paus rapporteras som idle: appen
// äger den inte, och ett "active" hade fått appen att hoppa in i sin
// pausskärm (RESTORE vid återanslutning) för en paus den inte ska spara.
const char* phaseName(Phase p) {
  if (sessionOwner == OWNER_TAG) return "idle";
  switch (p) {
    case CHECKED_IN:   return "checked_in";
    case AWAITING_LID: return "awaiting_lid";
    case ACTIVE:       return "active";
    case SHOWING_TIME: return "active";
    case RESPITE:      return "respite";
    default:           return "idle";
  }
}

unsigned long phaseStartMs = 0;
extern char lastDrawnQr[64];

// Senaste gången något hände: locket, en tagg, appen, inställningssidan, en
// ny fas. Viloläget räknar från den. Skrivs också från Bluetooth-tråden,
// därför volatile (en unsigned long skrivs i ett svep på ESP32).
volatile unsigned long lastActivityMs = 0;

void setPhase(Phase p) {
  phase = p;
  phaseStartMs = millis();
  lastActivityMs = phaseStartMs;
  lastDrawnQr[0] = 0;   // QR-bilden ritas bara om vid byte — tvinga det här
}

uint32_t      activeSeq        = 0;
unsigned long sessionSegmentMs = 0;
unsigned long sessionAccumMs   = 0;
unsigned long lastCheckpointMs = 0;
unsigned long respiteStartMs   = 0;
uint32_t      endedDurationMs  = 0;
bool          endedWasRecord   = false;

bool sessionRunning() {
  return phase == ACTIVE || phase == CHECKED_IN;
}

bool sessionExists() {
  return sessionRunning() || phase == RESPITE;
}

unsigned long elapsedMs() {
  if (sessionRunning()) return sessionAccumMs + (millis() - sessionSegmentMs);
  return sessionAccumMs;
}

bool lidClosed  = false;
bool lastLidRaw = false;
unsigned long lastLidChangeMs = 0;

// ─── NFC: läsaren ───────────────────────────────────────────

MFRC522 rfid(RC522_SS_PIN, RC522_RST_PIN);

bool          tagPresent   = false;   // avstudsad: borta först efter TAG_GONE_MS
char          tagUid[21]   = "";      // senast lästa taggen
unsigned long tagLastSeenMs = 0;
unsigned long lastTagPollMs = 0;
unsigned long lastReaderCheckMs = 0;

// Utan standardargument: Arduino flyttar funktionsdeklarationerna överst och
// klarar inte ett standardvärde i dem.
void startReaderQuiet() {
  rfid.PCD_Init();
  delay(50);
  rfid.PCD_SetAntennaGain(rfid.RxGain_max);   // kopior (0x88) läser bättre med full förstärkning
}

void startReader() {
  startReaderQuiet();
  rfid.PCD_DumpVersionToSerial();
}

// Läsaren kan svara rätt på sin version och ändå ha tappat antennen eller
// förstärkningen — ett glapp på SPI kan skriva fel i ett register. Då läser
// den ingen tagg alls och ser ändå frisk ut. Därför kollas alla tre.
bool readerOk() {
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  if (!(v == 0x88 || v == 0x90 || v == 0x91 || v == 0x92 || v == 0x12 || v == 0xB2)) return false;
  if ((rfid.PCD_ReadRegister(MFRC522::TxControlReg) & 0x03) != 0x03) return false;   // antennen av
  if ((rfid.PCD_ReadRegister(MFRC522::RFCfgReg) & 0x70) != rfid.RxGain_max) return false;
  return true;
}

// Ett slumpat ID (4 byte som börjar på 0x08, enligt ISO 14443-3) är inte en
// tagg utan en telefon som själv låtsas vara ett NFC-kort, och det byts vid
// varje läsning. Registrerades ett sådant stod det NEW TAG varje gång
// telefonen lades i lådan. Pause-taggen (NTAG, börjar på 04) har ett fast ID.
bool uidIsRandom() {
  return rfid.uid.size == 4 && rfid.uid.uidByte[0] == 0x08;
}

// Läser taggen om den ligger på läsaren, även om den lästs nyss (WakeupA
// väcker också en tagg som satts i HALT efter förra läsningen).
// Svarar telefonen först läggs den i HALT, och läsaren frågar igen med
// RequestA, som bara når kort som inte är i HALT — alltså taggen.
bool readTagOnce(char* out) {
  byte atqa[2];
  byte size = sizeof(atqa);
  if (rfid.PICC_WakeupA(atqa, &size) != MFRC522::STATUS_OK) return false;
  if (!rfid.PICC_ReadCardSerial()) return false;
  if (uidIsRandom()) {
    rfid.PICC_HaltA();
    size = sizeof(atqa);
    if (rfid.PICC_RequestA(atqa, &size) != MFRC522::STATUS_OK) return false;
    if (!rfid.PICC_ReadCardSerial()) return false;
    if (uidIsRandom()) { rfid.PICC_HaltA(); return false; }
  }
  int n = 0;
  for (byte i = 0; i < rfid.uid.size && n <= 18; i++) {
    n += sprintf(out + n, "%02X", rfid.uid.uidByte[i]);
  }
  out[n] = 0;
  rfid.PICC_HaltA();
  return n > 0;
}

// ─── NFC: vad servern sa om taggen ──────────────────────────

TagInfo tagInfo = TI_NONE;
char    tagOwnerName[33] = "";

// QR-koden står kvar när telefonen lyfts. Man måste ju lyfta den för att
// skanna koden med samma telefon, och förr försvann koden i samma stund.
// Lådan minns taggen och fortsätter fråga servern tills koden använts,
// koden gått ut, eller en telefon läggs i igen.
const unsigned long PAIR_HOLD_MS     = 300000;  // som kodens giltighet på servern
const unsigned long PAIRED_SHOW_MS   = 4000;    // "HI, NAMN" efter registreringen
bool          pairHold        = false;
char          pairHoldUid[21] = "";
unsigned long pairHoldUntil   = 0;
unsigned long pairedShownAt   = 0;   // >0 = visa bekräftelsen
char          pairedName[33]  = "";
char    pairCode[11] = "";
char    pairUrl[96] = "";
unsigned long lastLookupMs = 0;
bool    startWhenKnown = false;   // locket stängdes medan svaret var på väg

// ─── Nätverks-task ──────────────────────────────────────────
//
// Allt som går över nätet sker här, på kärna 0. Loopen (kärna 1) lägger ett
// jobb och läser svaret när det är klart; den väntar aldrig. NVS skrivs bara
// i loopen.

SemaphoreHandle_t netMutex;

// Uppslag av en tagg (box-tag)
volatile bool lookupRequested = false;
volatile bool lookupDone      = false;
char  lookupUid[21]  = "";       // frågan (skrivs av loopen)
char  lookupResultUid[21] = "";  // vilken tagg svaret gäller (skrivs av tasken)
bool  lookupOk       = false;
char  lookupStatus[12] = "";
char  lookupName[33] = "";
char  lookupCode[11] = "";
char  lookupUrl[96]  = "";

// Uppladdning av en NFC-paus (box-session)
volatile bool uploadRequested = false;
volatile bool uploadDone      = false;
WifiRecord    uploadRec;
unsigned long uploadAgoMs     = 0;
int           uploadResult    = 0;   // 1 = klar (ta bort ur kön), 0 = försök igen
unsigned long lastUploadTryMs = 0;
bool          uploadBusy      = false;

volatile bool wifiUp = false;

// ─── WiFi: sparade nät och inställningsnätet ────────────────
//
// Lådan kommer ihåg upp till fem nät (NVS, namnrymden "wifi"), senast
// inställda först, plus nätet i secrets.h om det finns ett. Den letar efter
// alla och ansluter till det starkaste den hittar.
//
// Hittar den inget startar den ett eget öppet nät, "PausePod-XXXX". Den som
// ansluter till det med mobilen får upp en sida där man väljer WiFi och
// skriver lösenordet (som när man loggar in på ett café-WiFi). Skärmen visar
// en QR-kod som ansluter mobilen till nätet. När lådan väl är uppkopplad
// stängs nätet igen. Så kan lådan ställas in hemma hos vem som helst utan
// dator och utan att koden laddas om.

const int  WIFI_SAVED_MAX = 5;
const unsigned long WIFI_RETRY_MS     = 20000;  // nere: leta igen så här ofta
// Med inställningsnätet uppe letar lådan mycket mer sällan: sökningen byter
// radiokanal ett par sekunder, och en mobil som ansluter just då kastas ut
// ("anslutningen misslyckades"). Så länge en mobil är ansluten letar den inte alls.
const unsigned long PORTAL_RETRY_MS   = 300000;   // var 90 s; sökningen kastade ut mobiler mitt i anslutningen
const unsigned long PORTAL_LINGER_MS  = 20000;  // uppkopplad: låt sidan hinna svara
const unsigned long WIFI_OK_SHOW_MS   = 5000;   // "CONNECTED" på skärmen

struct WifiCred { char ssid[33]; char pass[65]; };
WifiCred wifiSaved[WIFI_SAVED_MAX];
int      wifiSavedCount = 0;
Preferences wifiPrefs;

// Inställningsnätet. Startas och stängs bara i loopen; nätverks-tasken
// läser bara flaggorna.
WebServer portalServer(80);
DNSServer portalDns;
volatile bool portalActive     = false;
volatile bool wifiNeedsSetup   = false;  // tasken: inget känt nät gick att nå
volatile bool connectRequested = false;  // sidan: anslut nu till det nya nätet
volatile int  wifiSetupResult  = 0;      // 0 inget, 1 ansluter, 2 klart, 3 misslyckades
char          apName[24]       = "PausePod";
char          connectedSsid[33] = "";
unsigned long portalStopAt     = 0;
unsigned long wifiOkShownAt    = 0;

void loadWifiSaved() {
  wifiPrefs.begin("wifi", true);
  int n = wifiPrefs.getInt("n", 0);
  wifiSavedCount = 0;
  for (int i = 0; i < n && i < WIFI_SAVED_MAX; i++) {
    char k[4];
    sprintf(k, "s%d", i);
    wifiPrefs.getString(k, wifiSaved[wifiSavedCount].ssid, sizeof(wifiSaved[0].ssid));
    sprintf(k, "p%d", i);
    wifiPrefs.getString(k, wifiSaved[wifiSavedCount].pass, sizeof(wifiSaved[0].pass));
    if (wifiSaved[wifiSavedCount].ssid[0]) wifiSavedCount++;
  }
  wifiPrefs.end();
  Serial.printf("WiFi: %d sparade nät\n", wifiSavedCount);
}

void storeWifiSaved() {
  wifiPrefs.begin("wifi", false);
  wifiPrefs.putInt("n", wifiSavedCount);
  for (int i = 0; i < wifiSavedCount; i++) {
    char k[4];
    sprintf(k, "s%d", i);
    wifiPrefs.putString(k, wifiSaved[i].ssid);
    sprintf(k, "p%d", i);
    wifiPrefs.putString(k, wifiSaved[i].pass);
  }
  wifiPrefs.end();
}

// Lägger nätet först. Fanns det redan byts lösenordet; listan hålls på fem.
void addWifiSaved(const char* ssid, const char* pass) {
  xSemaphoreTake(netMutex, portMAX_DELAY);
  WifiCred c;
  strncpy(c.ssid, ssid, sizeof(c.ssid) - 1); c.ssid[sizeof(c.ssid) - 1] = 0;
  strncpy(c.pass, pass, sizeof(c.pass) - 1); c.pass[sizeof(c.pass) - 1] = 0;
  WifiCred out[WIFI_SAVED_MAX];
  int n = 0;
  out[n++] = c;
  for (int i = 0; i < wifiSavedCount && n < WIFI_SAVED_MAX; i++) {
    if (strcmp(wifiSaved[i].ssid, c.ssid) != 0) out[n++] = wifiSaved[i];
  }
  memcpy(wifiSaved, out, sizeof(out));
  wifiSavedCount = n;
  xSemaphoreGive(netMutex);
  storeWifiSaved();
}

void forgetWifiSaved() {
  xSemaphoreTake(netMutex, portMAX_DELAY);
  wifiSavedCount = 0;
  xSemaphoreGive(netMutex);
  storeWifiSaved();
}

bool tryConnect(const char* ssid, const char* pass, unsigned long timeoutMs) {
  WiFi.begin(ssid, pass);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) delay(200);
  return WiFi.status() == WL_CONNECTED;
}

// Letar efter alla kända nät och ansluter till det starkaste. Körs bara i
// nätverks-tasken.
bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) { wifiUp = true; return true; }
  WiFi.mode(portalActive ? WIFI_AP_STA : WIFI_STA);

  WifiCred cands[WIFI_SAVED_MAX + 1];
  int n = 0;
  xSemaphoreTake(netMutex, portMAX_DELAY);
  for (int i = 0; i < wifiSavedCount; i++) cands[n++] = wifiSaved[i];
  xSemaphoreGive(netMutex);
#ifdef WIFI_SSID
  if (strlen(WIFI_SSID) > 0) {
    bool dup = false;
    for (int i = 0; i < n; i++) if (strcmp(cands[i].ssid, WIFI_SSID) == 0) dup = true;
    if (!dup) {
      strncpy(cands[n].ssid, WIFI_SSID, sizeof(cands[n].ssid) - 1); cands[n].ssid[sizeof(cands[n].ssid) - 1] = 0;
      strncpy(cands[n].pass, WIFI_PASSWORD, sizeof(cands[n].pass) - 1); cands[n].pass[sizeof(cands[n].pass) - 1] = 0;
      n++;
    }
  }
#endif
  if (n == 0) {
    Serial.println("WiFi: inga nät inställda");
    wifiUp = false;
    return false;
  }

  int found = WiFi.scanNetworks();
  int best = -1, bestRssi = -1000;
  for (int i = 0; i < found; i++) {
    String seen = WiFi.SSID(i);
    for (int c = 0; c < n; c++) {
      if (seen == cands[c].ssid && WiFi.RSSI(i) > bestRssi) { best = c; bestRssi = WiFi.RSSI(i); }
    }
  }
  WiFi.scanDelete();
  if (found < 0 && n > 0) best = 0;   // sökningen misslyckades: prova det senaste

  if (best < 0) {
    Serial.println("WiFi: inget känt nät i närheten");
    wifiUp = false;
    return false;
  }
  wifiUp = tryConnect(cands[best].ssid, cands[best].pass, 12000);
  if (wifiUp) {
    strncpy(connectedSsid, cands[best].ssid, sizeof(connectedSsid) - 1);
    Serial.printf("WiFi OK: %s (%s)\n", connectedSsid, WiFi.localIP().toString().c_str());
  } else {
    Serial.printf("WiFi: kunde inte ansluta till %s\n", cands[best].ssid);
  }
  return wifiUp;
}

// ── Inställningsnätets sida ──

String htmlEscape(const String& in) {
  String out;
  for (unsigned int i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '&') out += "&amp;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

// Näten i menyn söks fram INNAN inställningsnätet öppnas och sparas här.
// En sökning medan mobilen är ansluten byter radiokanal i flera sekunder, och
// sidan hann aldrig fram — mobilen visade en vit sida.
const int PORTAL_SSIDS_MAX = 15;
String portalSsids[PORTAL_SSIDS_MAX];
int    portalSsidCount = 0;

void scanForPortal() {
  portalSsidCount = 0;
  int found = WiFi.scanNetworks();
  // Starkast först, varje namn en gång
  for (int pass = 0; pass < found && portalSsidCount < PORTAL_SSIDS_MAX; pass++) {
    int best = -1;
    for (int i = 0; i < found; i++) {
      String ssid = WiFi.SSID(i);
      if (ssid.length() == 0) continue;
      bool taken = false;
      for (int j = 0; j < portalSsidCount; j++) if (portalSsids[j] == ssid) taken = true;
      if (taken) continue;
      if (best < 0 || WiFi.RSSI(i) > WiFi.RSSI(best)) best = i;
    }
    if (best < 0) break;
    portalSsids[portalSsidCount++] = WiFi.SSID(best);
  }
  WiFi.scanDelete();
  Serial.printf("WiFi: %d nät till inställningssidan\n", portalSsidCount);
}

// Sidan följer PausePod-designsystemet (joinpausepod.com): marinblå botten
// (bg #0a1330), en upphöjd panel (panel #111c3f) med 2 px ring-line (#1c2b58),
// ljusblått som enda handlingsfärg (accent #9ccbff, marinblå text ovanpå),
// pausmärket och ordmärket överst, rubrik i tjocka versaler, piller-knapp,
// fält med radius-field. Ingen emoji, inga utropstecken. Hela sidan bor i
// lådan och laddar ingenting utifrån — mobilen har ju inget internet här.
const char PORTAL_HEAD[] PROGMEM = R"HTML(<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PausePod WiFi</title>
<style>
:root{--bg:#0a1330;--panel:#111c3f;--line:#1c2b58;--fg:#eef3ff;--muted:#b3c1de;--accent:#9ccbff;--honey:#f0b978;
--display:"Arial Black","Arial Bold",Arial,"Helvetica Neue",Helvetica,sans-serif;--body:Arial,"Helvetica Neue",Helvetica,sans-serif}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:400 17px/27px var(--body);-webkit-text-size-adjust:100%}
.w{max-width:26rem;margin:0 auto;padding:28px 16px 40px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:44px}
.mark{display:flex;gap:4px}.mark i{display:block;width:6px;height:22px;border-radius:99px;background:var(--accent)}
.brand b{font:900 14px/14px var(--display);letter-spacing:.24em}
.k{font:900 12px/12px var(--display);letter-spacing:.2em;text-transform:uppercase;color:var(--accent);margin:0 0 14px}
h1{font:900 36px/36px var(--display);letter-spacing:-.02em;text-transform:uppercase;margin:0 0 16px}
p{margin:0 0 28px;color:var(--muted)}
.panel{background:var(--panel);border-radius:1.6rem;box-shadow:0 0 0 2px var(--line);padding:22px 18px 24px}
label{display:block;font:700 15px/24px var(--body);margin:0 0 8px}
.f{margin-bottom:18px}
select,input{width:100%;height:3.4rem;padding:0 16px;background:var(--bg);color:var(--fg);border:0;border-radius:.95rem;
box-shadow:inset 0 0 0 2px var(--line);font:400 17px var(--body);-webkit-appearance:none;appearance:none}
select{background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);
background-position:calc(100% - 22px) 50%,calc(100% - 16px) 50%;background-size:6px 6px;background-repeat:no-repeat;padding-right:40px}
.pw{position:relative}.pw input{padding-right:76px}
.pw button{position:absolute;right:6px;top:6px;height:calc(3.4rem - 12px);padding:0 14px;border:0;border-radius:99px;background:transparent;
color:var(--accent);font:900 12px var(--display);letter-spacing:.08em;text-transform:uppercase}
.go{display:block;width:100%;height:3.4rem;margin-top:24px;border:0;border-radius:99px;background:var(--accent);color:var(--bg);
font:900 14px/14px var(--display);letter-spacing:.08em;text-transform:uppercase}
.note{margin:0 0 20px;color:var(--honey);font:700 15px/24px var(--body)}
.small{font-size:15px;line-height:24px;color:var(--muted);margin:0}
.quiet{display:block;margin:28px auto 0;padding:10px 16px;min-height:44px;border:0;background:none;color:var(--muted);
font:400 15px var(--body);text-decoration:underline;text-underline-offset:3px}
.hide{display:none}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
</style></head><body><div class="w">
<div class="brand"><span class="mark"><i></i><i></i></span><b>PAUSEPOD</b></div>
)HTML";

const char PORTAL_SCRIPT[] PROGMEM = R"HTML(<script>
var s=document.getElementById('ssid'),o=document.getElementById('other');
function t(){if(s)o.classList.toggle('hide',s.value!=='');}
if(s){s.onchange=t;t();}
var b=document.getElementById('show'),p=document.getElementById('pass');
b.onclick=function(){var h=p.type==='password';p.type=h?'text':'password';b.textContent=h?'Hide':'Show';};
</script>)HTML";

void sendPortalPage(const String& body) {
  String page = FPSTR(PORTAL_HEAD);
  page += body;
  page += "</div></body></html>";
  portalServer.send(200, "text/html; charset=utf-8", page);
}

void handlePortalRoot() {
  lastActivityMs = millis();
  Serial.println("WiFi-sidan: visar inställningssidan");
  String body;
  body += "<p class=\"k\">WiFi setup</p><h1>Connect<br>your box</h1>";
  body += "<p>Choose the WiFi at home. The box saves your pauses through it.</p>";
  body += "<form class=\"panel\" method=\"post\" action=\"/save\">";
  if (wifiSetupResult == 3) body += "<p class=\"note\">That didn't work. Check the password and try again.</p>";

  if (portalSsidCount > 0) {
    body += "<div class=\"f\"><label for=\"ssid\">Network</label><select id=\"ssid\" name=\"ssid\">";
    for (int i = 0; i < portalSsidCount; i++) body += "<option>" + htmlEscape(portalSsids[i]) + "</option>";
    body += "<option value=\"\">Other network</option></select></div>";
    body += "<div class=\"f hide\" id=\"other\">";
  } else {
    body += "<div class=\"f\" id=\"other\">";
  }
  body += "<label for=\"ssid2\">Network name</label>"
          "<input id=\"ssid2\" name=\"ssid2\" autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\"></div>";

  body += "<div class=\"f\"><label for=\"pass\">Password</label><div class=\"pw\">"
          "<input id=\"pass\" name=\"pass\" type=\"password\" autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\">"
          "<button type=\"button\" id=\"show\">Show</button></div></div>";
  body += "<p class=\"small\">2.4 GHz only. If the router has a 5G network, pick the other one.</p>";
  body += "<button class=\"go\" type=\"submit\">Connect</button></form>";
  body += "<form method=\"post\" action=\"/forget\"><button class=\"quiet\" type=\"submit\">Forget saved networks</button></form>";
  body += FPSTR(PORTAL_SCRIPT);
  sendPortalPage(body);
}

void handlePortalSave() {
  lastActivityMs = millis();
  String ssid = portalServer.arg("ssid2");
  ssid.trim();
  if (ssid.length() == 0) ssid = portalServer.arg("ssid");
  String pass = portalServer.arg("pass");
  if (ssid.length() == 0) {
    portalServer.sendHeader("Location", "/");
    portalServer.send(302, "text/plain", "");
    return;
  }
  addWifiSaved(ssid.c_str(), pass.c_str());
  Serial.printf("WiFi: nytt nät från sidan: %s\n", ssid.c_str());
  wifiSetupResult = 1;
  connectRequested = true;
  String body;
  body += "<p class=\"k\">WiFi setup</p><h1>Connecting</h1>";
  body += "<p>Look at the box. It says CONNECTED when it's done, and this page closes.</p>";
  body += "<div class=\"panel\"><p class=\"small\">Network: <b style=\"color:var(--fg)\">" + htmlEscape(ssid) + "</b></p></div>";
  body += "<p class=\"small\" style=\"margin-top:20px\">If the box shows the setup code again, the password was wrong. Scan it and try once more.</p>";
  sendPortalPage(body);
}

void handlePortalForget() {
  forgetWifiSaved();
  Serial.println("WiFi: sparade nät glömda");
  portalServer.sendHeader("Location", "/");
  portalServer.send(302, "text/plain", "");
}

// Allt annat (mobilernas egna "finns det internet?"-frågor) skickas till
// sidan. Det är så sidan dyker upp av sig själv när mobilen ansluter.
void handlePortalOther() {
  Serial.printf("WiFi-sidan: mobilen frågade efter %s%s\n",
                portalServer.hostHeader().c_str(), portalServer.uri().c_str());
  portalServer.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/");
  portalServer.send(302, "text/plain", "");
}

bool portalRoutesAdded = false;

void startPortal() {
  WiFi.mode(WIFI_STA);
  scanForPortal();   // innan någon mobil hunnit ansluta
  WiFi.mode(WIFI_AP_STA);
  // DNS måste anges uttryckligen: utan det delar ESP32 inte ut någon DNS till
  // mobilen, mobilens "finns det internet?"-koll når aldrig lådan, och mobilen
  // kopplar ner och byter till ett annat nät. Med lådan som DNS svarar den
  // på kollen med sin egen sida, och mobilen visar "Logga in på nätverket".
  const IPAddress apIp(192, 168, 4, 1);
  WiFi.softAPConfig(apIp, apIp, IPAddress(255, 255, 255, 0), IPAddress(192, 168, 4, 2), apIp);
  static bool eventsAdded = false;
  if (!eventsAdded) {
    // Vad som händer när en mobil ansluter, rad för rad i Serial Monitor.
    // Fastnar det före "fick IP" är det radion; efter, är det sidan.
    WiFi.onEvent([](WiFiEvent_t e, WiFiEventInfo_t) {
      if (e == ARDUINO_EVENT_WIFI_AP_STACONNECTED)    Serial.println("WiFi: en mobil anslöt till inställningsnätet");
      if (e == ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED)   Serial.println("WiFi: mobilen fick IP-adress");
      if (e == ARDUINO_EVENT_WIFI_AP_STADISCONNECTED) Serial.println("WiFi: mobilen kopplade ner från inställningsnätet");
    });
    eventsAdded = true;
  }
  WiFi.softAP(apName, nullptr, 1, 0, 4);
  delay(100);
  portalDns.start(53, "*", WiFi.softAPIP());
  if (!portalRoutesAdded) {
    portalServer.on("/", HTTP_GET, handlePortalRoot);
    portalServer.on("/save", HTTP_POST, handlePortalSave);
    portalServer.on("/forget", HTTP_POST, handlePortalForget);
    // Mobilernas egna kontroller (Android, iPhone, Windows): svara med en
    // omdirigering till sidan, så att de förstår att det är ett inloggningsnät.
    portalServer.on("/generate_204", handlePortalOther);
    portalServer.on("/gen_204", handlePortalOther);
    portalServer.on("/hotspot-detect.html", handlePortalOther);
    portalServer.on("/library/test/success.html", handlePortalOther);
    portalServer.on("/connecttest.txt", handlePortalOther);
    portalServer.on("/ncsi.txt", handlePortalOther);
    portalServer.onNotFound(handlePortalOther);
    portalRoutesAdded = true;
  }
  portalServer.begin();
  portalActive = true;
  portalStopAt = 0;
  lastDrawnQr[0] = 0;
  Serial.printf("WiFi: inställningsnätet %s är uppe (%s)\n", apName, WiFi.softAPIP().toString().c_str());
}

void stopPortal() {
  portalServer.stop();
  portalDns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  portalActive = false;
  wifiNeedsSetup = false;
  lastDrawnQr[0] = 0;
  Serial.println("WiFi: inställningsnätet stängt");
}

// Körs i loopen: öppnar nätet när inget känt nät nås, stänger det en stund
// efter att lådan kommit upp.
void handlePortal() {
  if (portalActive) {
    portalDns.processNextRequest();
    portalServer.handleClient();
  }
  unsigned long now = millis();
  if (!portalActive && wifiNeedsSetup && !wifiUp) startPortal();
  if (portalActive && wifiUp && portalStopAt == 0) portalStopAt = now + PORTAL_LINGER_MS;
  if (portalActive && portalStopAt != 0 && (long)(now - portalStopAt) >= 0) stopPortal();
  if (wifiSetupResult == 2 && wifiOkShownAt == 0) wifiOkShownAt = now;
  if (wifiOkShownAt != 0 && now - wifiOkShownAt > WIFI_OK_SHOW_MS) {
    wifiSetupResult = 0;
    wifiOkShownAt = 0;
  }
}

// En telefon som står på inställningssidan ska inte tappa nätet för att
// lådan letar i bakgrunden (sökningen byter kanal en stund).
bool phoneOnPortal() {
  return portalActive && WiFi.softAPgetStationNum() > 0;
}

// POST till en edge-funktion. Returnerar HTTP-koden (0 = inget svar).
int postToFunction(const char* fn, const String& body, String& response) {
  // Med inställningsnätet uppe letar bara tasken efter WiFi, i sin egen takt.
  if (WiFi.status() != WL_CONNECTED && portalActive) return 0;
  if (!ensureWifi()) return 0;
  WiFiClientSecure client;
  client.setInsecure();   // PROTOTYP: certifikatet kontrolleras inte. setCACert före lansering.
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, String(SUPABASE_URL) + "/functions/v1/" + fn)) return 0;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-box-id", BOX_ID);
  http.addHeader("x-box-key", BOX_KEY);
  int code = http.POST(body);
  response = http.getString();
  http.end();
  return code;
}

void doLookup() {
  char uid[21];
  xSemaphoreTake(netMutex, portMAX_DELAY);
  strncpy(uid, lookupUid, sizeof(uid));
  xSemaphoreGive(netMutex);

  String response;
  int code = postToFunction("box-tag", String("{\"tag_uid\":\"") + uid + "\"}", response);

  JsonDocument doc;
  bool ok = (code == 200) && !deserializeJson(doc, response);

  xSemaphoreTake(netMutex, portMAX_DELAY);
  lookupOk = ok;
  if (ok) {
    strncpy(lookupStatus, doc["status"] | "", sizeof(lookupStatus) - 1);
    strncpy(lookupName,   doc["username"] | "", sizeof(lookupName) - 1);
    strncpy(lookupCode,   doc["code"] | "", sizeof(lookupCode) - 1);
    strncpy(lookupUrl,    doc["url"] | "", sizeof(lookupUrl) - 1);
  } else {
    Serial.printf("box-tag svarade %d: %s\n", code, response.c_str());
  }
  // Loopen kan ha frågat om en annan tagg medan anropet pågick, så svaret
  // märks med taggen det gäller — lookupUid är frågan, inte svaret.
  strncpy(lookupResultUid, uid, sizeof(lookupResultUid));
  xSemaphoreGive(netMutex);
}

void doUpload() {
  WifiRecord r;
  unsigned long ago;
  xSemaphoreTake(netMutex, portMAX_DELAY);
  r = uploadRec;
  ago = uploadAgoMs;
  xSemaphoreGive(netMutex);

  char body[200];
  snprintf(body, sizeof(body),
           "{\"tag_uid\":\"%s\",\"seq\":%lu,\"duration_ms\":%lu,\"completed\":%s,\"ended_ago_ms\":%lu}",
           r.tagUid, (unsigned long)r.seq, (unsigned long)r.durationMs,
           r.completed ? "true" : "false", ago);

  String response;
  int code = postToFunction("box-session", String(body), response);
  JsonDocument doc;
  bool parsed = (code == 200) && !deserializeJson(doc, response);
  const char* status = parsed ? (doc["status"] | "") : "";
  Serial.printf("box-session seq %lu → %d %s\n", (unsigned long)r.seq, code, response.c_str());

  // saved/duplicate = sparad. unknown_tag/invalid = kommer aldrig att lyckas,
  // så den tas också bort i stället för att stå och skickas om för evigt.
  int result = (parsed && status[0] != 0) ? 1 : 0;
  xSemaphoreTake(netMutex, portMAX_DELAY);
  uploadResult = result;
  xSemaphoreGive(netMutex);
}

void netTask(void*) {
  if (!ensureWifi()) wifiNeedsSetup = true;
  unsigned long lastWifiTry = millis();
  for (;;) {
    if (lookupRequested) {
      lookupRequested = false;
      doLookup();
      lookupDone = true;
    } else if (uploadRequested) {
      uploadRequested = false;
      doUpload();
      uploadDone = true;
    } else {
      if (WiFi.status() != WL_CONNECTED) wifiUp = false;
      bool requested = connectRequested;
      unsigned long retryMs = portalActive ? PORTAL_RETRY_MS : WIFI_RETRY_MS;
      if (requested || (!wifiUp && !phoneOnPortal() && millis() - lastWifiTry > retryMs)) {
        connectRequested = false;
        lastWifiTry = millis();
        if (requested) WiFi.disconnect();   // byt till det nya nätet även om ett gammalt nås
        bool ok = ensureWifi();
        if (requested) wifiSetupResult = ok ? 2 : 3;
        if (!ok) wifiNeedsSetup = true;
      }
      vTaskDelay(pdMS_TO_TICKS(30));
    }
  }
}

void requestLookup(const char* uid) {
  xSemaphoreTake(netMutex, portMAX_DELAY);
  strncpy(lookupUid, uid, sizeof(lookupUid) - 1);
  lookupUid[sizeof(lookupUid) - 1] = 0;
  xSemaphoreGive(netMutex);
  lookupDone = false;
  lookupRequested = true;
  lastLookupMs = millis();
}

// ─── Display ────────────────────────────────────────────────
//
// Skärmen följer PausePod-designsystemet, och lådan bor i appens NATTRUM
// (app-night-*): det är rummet där en paus pågår, och det är mörkt i båda
// lägena. Det betyder:
//
//  - Marinblå botten, gräddvitt bläck (aldrig rent vitt eller grått).
//  - Pausmärket — två stående rundade staplar — i appens accent #2e86de.
//    Det är det enda "ifyllda" på skärmen, som PAUSE-knappen i appen.
//  - Rummets ljusblå (night-hue) för etiketter och mätare.
//  - Grönt är lådans bekräftelse och syns bara i startceremonins bock.
//  - Honung är den varma vändningen: ON HOLD och PAUSE DONE.
//  - Rubriker i versaler, tjocka (närmast Arial Black som går att få ur
//    TFT_eSPI: FreeSansBold ritad två gånger med en pixels förskjutning).
//    Instruktioner på tre till fyra ord, inga utropstecken, inga pronomen.
//  - Mätare är stående rundade staplar, som märket.
//  - Bakgrunden rör sig inte. Bara märket andas på startsidan.
//
// Utan PSRAM ritas skärmen i 8 bitar, och då blir marinblått svart och
// tonerna grövre. Slå på Verktyg → PSRAM → "OPI PSRAM" för rätt färger.

TFT_eSPI tft = TFT_eSPI();
TFT_eSprite sprite = TFT_eSprite(&tft);
bool spriteOK = false;

// Rgb bor i pausepod_types.h: Arduino lägger funktionsdeklarationer överst i
// filen, före allt annat, så en typ i en funktions signatur måste finnas där.

// Ur designsystemet (tokens.json i PausePod-systemet)
// Botten, ytan och spåren är mörkare än appens night-bg (#0b1630): på lådans
// IPS-skärm lyste den marinblå som intensivt blå. Nästan svart med en aning
// blått ger märket och glorian något att lysa mot.
const Rgb C_BG     = {0x03, 0x06, 0x0e};  // nästan svart, en aning blått
const Rgb C_SURF   = {0x0a, 0x11, 0x24};  // yta i pillerna
const Rgb C_LINE   = {0x16, 0x22, 0x44};  // spår, tomma staplar, ringar
const Rgb C_HUE    = {0x8c, 0xbc, 0xff};  // app-night-hue: etiketter, mätare
const Rgb C_ACCENT = {0x2e, 0x86, 0xde};  // app-accent: pausmärket
const Rgb C_INK    = {0xff, 0xf4, 0xec};  // gräddvitt bläck, rgba(255,244,236,a)
const Rgb C_HONEY  = {0xf0, 0xb9, 0x78};  // honey: den varma vändningen
const Rgb C_GREEN  = {0x3c, 0xc8, 0x78};  // lådans GREEN: bara bocken

uint16_t BG, SURF, LINE, HUE, ACCENT, INK, INK_2, INK_3, HONEY, GREEN;

uint16_t col(Rgb c) { return tft.color565(c.r, c.g, c.b); }

// a → b, k = 0..1. Används för toningar och för bläckets alfanivåer.
uint16_t mix(Rgb a, Rgb b, float k) {
  if (k < 0.0) k = 0.0;
  if (k > 1.0) k = 1.0;
  return tft.color565(a.r + (b.r - a.r) * k + 0.5,
                      a.g + (b.g - a.g) * k + 0.5,
                      a.b + (b.b - a.b) * k + 0.5);
}

// En färg tonad upp ur botten.
uint16_t fadeIn(Rgb c, float k) { return mix(C_BG, c, k); }

void initColors() {
  BG     = col(C_BG);
  SURF   = col(C_SURF);
  LINE   = col(C_LINE);
  HUE    = col(C_HUE);
  ACCENT = col(C_ACCENT);
  INK    = col(C_INK);
  INK_2  = mix(C_BG, C_INK, 0.68);   // brödtext
  INK_3  = mix(C_BG, C_INK, 0.50);   // tredje nivån, aldrig under 0.5
  HONEY  = col(C_HONEY);
  GREEN  = col(C_GREEN);
}

const int SCREEN_W = 320;
const int SCREEN_H = 170;
const int CENTER_X = 160;
const int CENTER_Y = 85;
const int RING_R = 46;
const unsigned long BREATH_CYCLE_MS = 8000;

unsigned long lastFrame = 0;
const unsigned long FRAME_INTERVAL_MS = 33;

// ── Former ──

// Pausmärket: två stående staplar med helt rundade ändar.
void drawPauseMark(int cx, int cy, int h, uint16_t color) {
  int w   = max(4, (h * 10) / 36);
  int gap = max(3, (w * 4) / 5);
  int x   = cx - w - gap / 2;
  int y   = cy - h / 2;
  sprite.fillSmoothRoundRect(x, y, w, h, w / 2, color);
  sprite.fillSmoothRoundRect(x + w + gap, y, w, h, w / 2, color);
}

// En pill: helt rundad rektangel. Med `ring` ritas bara en 2 px kant runt
// `fill` — designsystemets ring-line i stället för skugga.
void drawPill(int cx, int cy, int w, int h, uint16_t fill, uint16_t ring) {
  int x = cx - w / 2, y = cy - h / 2;
  if (ring != fill) {
    sprite.fillSmoothRoundRect(x, y, w, h, h / 2, ring);
    sprite.fillSmoothRoundRect(x + 2, y + 2, w - 4, h - 4, h / 2 - 2, fill);
  } else {
    sprite.fillSmoothRoundRect(x, y, w, h, h / 2, fill);
  }
}

// Hel ring, kantutjämnad.
void drawRing(int cx, int cy, int r, int thickness, uint16_t color) {
  sprite.fillSmoothCircle(cx, cy, r + thickness / 2, color);
  sprite.fillSmoothCircle(cx, cy, r - thickness / 2, BG);
}

void drawCheck(int cx, int cy, int size, int thickness, float progress, uint16_t color) {
  if (progress <= 0.0) return;
  if (progress > 1.0) progress = 1.0;
  float ax = cx - size * 0.42, ay = cy + size * 0.05;
  float bx = cx - size * 0.10, by = cy + size * 0.34;
  float ex = cx + size * 0.45, ey = cy - size * 0.32;
  const float SHORT_PART = 0.35;
  if (progress <= SHORT_PART) {
    float t = progress / SHORT_PART;
    sprite.drawWideLine(ax, ay, ax + (bx - ax) * t, ay + (by - ay) * t, thickness, color);
  } else {
    float t = (progress - SHORT_PART) / (1.0 - SHORT_PART);
    sprite.drawWideLine(ax, ay, bx, by, thickness, color);
    sprite.drawWideLine(bx, by, bx + (ex - bx) * t, by + (ey - by) * t, thickness, color);
  }
}

// Mjuk gloria bakom pausmärket, räknad pixel för pixel: ljusast närmast
// märket och borta vid kanten, utan trappsteg. Står still — det är inte
// bakgrunden som rör sig, det är märket som lyser.
//
// En gloria behöver många mellantoner av blått, och i 8 bitar (PSRAM av)
// finns bara fyra blå nivåer: den blev hackiga ringar. Där ritas ingen.
bool deepColor = true;   // sätts i setup(): 16 bitar = PSRAM finns

const uint8_t BAYER4[4][4] = {{0, 8, 2, 10}, {12, 4, 14, 6}, {3, 11, 1, 9}, {15, 7, 13, 5}};

void drawHalo(int cx, int cy, int r, float k) {
  if (!deepColor || k <= 0.0) return;
  const float PEAK = 0.30;   // hur starkt den lyser mitt bakom märket
  const float r2 = (float)r * r;
  for (int y = -r; y <= r; y++) {
    for (int x = -r; x <= r; x++) {
      float d2 = (float)x * x + (float)y * y;
      if (d2 >= r2) continue;
      float t = 1.0 - sqrtf(d2) / r;      // 1 i mitten, 0 vid kanten
      float a = t * t * (3.0 - 2.0 * t);  // smoothstep: mjuk ut mot kanten
      float m = a * PEAK * k;
      if (m < 0.003) continue;   // ytterkanten: lämna botten orörd
      // Bayer-dither: skärmen har 32 nivåer rött/blått och 64 grönt, och i
      // de mörka tonerna syns stegen som ringar. Ett fint mönster av ±ett
      // halvt steg får ögat att se mellantonerna i stället.
      float n = (BAYER4[(y + r) & 3][(x + r) & 3] + 0.5) / 16.0 - 0.5;
      float rr = C_BG.r + (C_ACCENT.r - C_BG.r) * m + n * 8.0;
      float gg = C_BG.g + (C_ACCENT.g - C_BG.g) * m + n * 4.0;
      float bb = C_BG.b + (C_ACCENT.b - C_BG.b) * m + n * 8.0;
      sprite.drawPixel(cx + x, cy + y,
        // Aldrig mörkare än botten: annars blir glorians ytterkant en mörk ring.
        tft.color565(constrain(rr, (float)C_BG.r, 255.0f), constrain(gg, (float)C_BG.g, 255.0f),
                     constrain(bb, (float)C_BG.b, 255.0f)));
    }
  }
}

// ── Text ──

// Rubrik: versaler, tjock. Ritas två gånger med en pixel emellan, för
// TFT_eSPI har ingen Arial Black.
void drawHeavy(const String& s, int x, int y, uint16_t color) {
  sprite.setTextColor(color);
  sprite.drawString(s, x, y);
  sprite.drawString(s, x + 1, y);
}

// Största rubrikstorleken som får plats på `maxW`.
void fitHeadline(const String& s, int maxW) {
  sprite.setFreeFont(&FreeSansBold24pt7b);
  if (sprite.textWidth(s) + 1 <= maxW) return;
  sprite.setFreeFont(&FreeSansBold18pt7b);
  if (sprite.textWidth(s) + 1 <= maxW) return;
  sprite.setFreeFont(&FreeSansBold12pt7b);
}

// Liten etikett över en rubrik (designsystemets "kicker").
void drawKicker(const char* s, int x, int y, uint16_t color) {
  sprite.setFreeFont(&FreeSansBold9pt7b);
  sprite.setTextColor(color);
  sprite.drawString(s, x, y);
}

void drawBody(const char* s, int x, int y, uint16_t color) {
  sprite.setFreeFont(&FreeSans9pt7b);
  sprite.setTextColor(color);
  sprite.drawString(s, x, y);
}

// Instruktion i en pill med ring, centrerad.
void drawInstructionPill(const char* s, int cy, uint16_t text, uint16_t ring) {
  sprite.setFreeFont(&FreeSansBold9pt7b);
  int w = sprite.textWidth(s) + 40;
  drawPill(CENTER_X, cy, w, 32, BG, ring);
  sprite.setTextDatum(MC_DATUM);
  sprite.setTextColor(text);
  sprite.drawString(s, CENTER_X, cy);
}

// ── Tid ──

float breathProgress(unsigned long elapsed) {
  elapsed = elapsed % BREATH_CYCLE_MS;
  if (elapsed < BREATH_CYCLE_MS / 2) {
    float t = elapsed / (float)(BREATH_CYCLE_MS / 2);
    return 0.5 - 0.5 * cos(t * PI);
  }
  float t = (elapsed - BREATH_CYCLE_MS / 2) / (float)(BREATH_CYCLE_MS / 2);
  return 1.0 - (0.5 - 0.5 * cos(t * PI));
}

String formatDuration(uint64_t ms) {
  uint32_t totalSec = ms / 1000;
  uint32_t h = totalSec / 3600;
  uint32_t m = (totalSec % 3600) / 60;
  uint32_t s = totalSec % 60;
  char buf[16];
  if (h > 0) sprintf(buf, "%lu:%02lu:%02lu", (unsigned long)h, (unsigned long)m, (unsigned long)s);
  else       sprintf(buf, "%02lu:%02lu", (unsigned long)m, (unsigned long)s);
  return String(buf);
}

// Batterinivån ur spänningen. En LiPo är inte linjär: den ligger länge runt
// 3,7–3,9 V och faller sedan snabbt, så en rak linje 3,3–4,2 V visade 20 %
// när batteriet i själva verket nästan var tomt. Tabellen är en vanlig
// urladdningskurva för en cell; spänningen mäts genom kortets 2:1-delare.
// Med USB-C i ligger laddspänningen på och nivån visar nära 100 %.
int batteryPercent() {
  float v = analogReadMilliVolts(BATTERY_ADC_PIN) * 2.0 / 1000.0;
  const float V[] = {3.30, 3.50, 3.60, 3.65, 3.70, 3.75, 3.80, 3.90, 4.00, 4.10, 4.20};
  const int   P[] = {   0,    3,    8,   15,   25,   35,   45,   62,   77,   90,  100};
  if (v <= V[0]) return 0;
  for (int i = 1; i < 11; i++) {
    if (v <= V[i]) return P[i - 1] + (int)((v - V[i - 1]) / (V[i] - V[i - 1]) * (P[i] - P[i - 1]));
  }
  return 100;
}

// Batterinivån som skärmen visar. Läses var 20:e sekund och medelvärdesbildas,
// så att symbolen inte blinkar fram och tillbaka vid 20 %.
const int BATTERY_LOW_PCT      = 20;   // symbolen syns
const int BATTERY_CRITICAL_PCT = 10;   // + texten LOW BATTERY
int shownBatteryPct = 100;
unsigned long lastBatteryReadMs = 0;

void updateShownBattery() {
  unsigned long now = millis();
  if (lastBatteryReadMs != 0 && now - lastBatteryReadMs < 20000) return;
  int p = batteryPercent();
  shownBatteryPct = (lastBatteryReadMs == 0) ? p : (shownBatteryPct * 3 + p) / 4;
  lastBatteryReadMs = now;
}

// En liten batterisymbol uppe till höger, bara när batteriet börjar ta slut.
// Honung, designsystemets varma "observera": ingen röd larmfärg, lådan ska
// inte skrika. Under 10 % får den en rad text bredvid sig.
void drawBatteryWarning() {
  if (shownBatteryPct > BATTERY_LOW_PCT) return;
  const int w = 22, h = 11, x = SCREEN_W - 14 - w, y = 12;
  sprite.drawRoundRect(x, y, w, h, 3, HONEY);
  sprite.fillRoundRect(x + w, y + 3, 3, 5, 1, HONEY);   // knoppen
  int fill = max(2, (int)((w - 4) * shownBatteryPct / 100.0 + 0.5));
  sprite.fillRect(x + 2, y + 2, fill, h - 4, HONEY);
  if (shownBatteryPct <= BATTERY_CRITICAL_PCT) {
    sprite.setTextDatum(MR_DATUM);
    sprite.setFreeFont(&FreeSansBold9pt7b);
    sprite.setTextColor(HONEY);
    sprite.drawString("LOW BATTERY", x - 8, y + h / 2);
  }
}

// Alla skärmar lämnas till displayen härigenom, så att batterisymbolen
// hamnar överst på dem alla.
void pushFrame() {
  drawBatteryWarning();
  sprite.pushSprite(0, 0);
}

// Namnet i versaler och kortat så att det ryms på en rad.
String displayName() {
  String n = String(tagOwnerName);
  n.toUpperCase();
  if (n.length() > 14) n = n.substring(0, 14);
  return n;
}

// ─── Renderare ──────────────────────────────────────────────

// Ingen telefon: märket andas bredvid ordmärket.
void renderLogo() {
  sprite.fillSprite(BG);
  float b = breathProgress(millis() - phaseStartMs);

  sprite.setFreeFont(&FreeSansBold18pt7b);
  String word = "PAUSEPOD";
  int wordW = sprite.textWidth(word) + 1;
  const int markH = 34, markBox = 28, gap = 14;
  int x0 = (SCREEN_W - (markBox + gap + wordW)) / 2;

  drawPauseMark(x0 + markBox / 2, 72, markH, fadeIn(C_ACCENT, 0.45 + 0.55 * b));
  sprite.setTextDatum(ML_DATUM);
  drawHeavy(word, x0 + markBox + gap, 72, INK);

  sprite.setTextDatum(MC_DATUM);
  drawBody("Phone in to start.", CENTER_X, 124, INK_2);
  pushFrame();
}

// Taggen läst, servern tillfrågad: märkets staplar turas om att lysa.
void renderChecking() {
  sprite.fillSprite(BG);
  float t = ((millis() - phaseStartMs) % 1200) / 1200.0;
  float kl = 0.5 + 0.5 * cos(t * 2 * PI);
  const int h = 40, w = 11, gap = 9;
  int x = CENTER_X - w - gap / 2;
  sprite.fillSmoothRoundRect(x, 66 - h / 2, w, h, w / 2, fadeIn(C_ACCENT, 0.35 + 0.65 * kl));
  sprite.fillSmoothRoundRect(x + w + gap, 66 - h / 2, w, h, w / 2, fadeIn(C_ACCENT, 0.35 + 0.65 * (1 - kl)));

  sprite.setTextDatum(MC_DATUM);
  drawBody("Checking the tag.", CENTER_X, 122, INK_2);
  pushFrame();
}

// Känd tagg: hälsningen och vad som händer härnäst.
void renderHello() {
  sprite.fillSprite(BG);
  String hi = String("HI, ") + displayName();
  sprite.setTextDatum(MC_DATUM);
  fitHeadline(hi, SCREEN_W - 32);
  drawHeavy(hi, CENTER_X, 62, INK);
  drawInstructionPill("LID DOWN TO START", 118, HUE, LINE);
  pushFrame();
}

void renderOffline() {
  sprite.fillSprite(BG);
  drawPauseMark(CENTER_X, 50, 30, LINE);
  sprite.setTextDatum(MC_DATUM);
  sprite.setFreeFont(&FreeSansBold18pt7b);
  drawHeavy("NO CONNECTION", CENTER_X, 98, INK);
  drawBody(portalActive ? "Lift the phone to set up WiFi." : "Trying again.", CENTER_X, 134, INK_2);
  pushFrame();
}

// ── QR ──
//
// esp_qrcode ritar via en callback utan användardata, så rutan bor här.
const int QR_AREA = 138;   // den vita rutans sida
const int QR_X    = 14;
const int QR_PAD  = 8;     // tyst zon innanför den vita kanten

void drawQrToSprite(esp_qrcode_handle_t qr) {
  const int modules = esp_qrcode_get_size(qr);
  const int scale = (QR_AREA - 2 * QR_PAD) / modules;
  const int size = modules * scale;
  const int box = size + 2 * QR_PAD;
  const int bx = QR_X + (QR_AREA - box) / 2;
  const int by = (SCREEN_H - box) / 2;
  sprite.fillSmoothRoundRect(bx, by, box, box, 10, TFT_WHITE);
  for (int y = 0; y < modules; y++) {
    for (int x = 0; x < modules; x++) {
      if (esp_qrcode_get_module(qr, x, y)) {
        sprite.fillRect(bx + QR_PAD + x * scale, by + QR_PAD + y * scale, scale, scale, TFT_BLACK);
      }
    }
  }
}

// QR-koden till vänster och en spalt till höger: etikett, två rader rubrik,
// en rad text och en pill. Används av en ny tagg och av WiFi-inställningen.
void renderQrPanel(const char* qrText, const char* kicker, const char* h1, const char* h2,
                   const char* small, const char* pillText) {
  sprite.fillSprite(BG);
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = drawQrToSprite;
  cfg.max_qrcode_version = 10;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;
  esp_qrcode_generate(&cfg, qrText);

  const int x = QR_X + QR_AREA + 16;          // högerspaltens vänsterkant
  const int colW = SCREEN_W - x - 12;
  sprite.setTextDatum(TL_DATUM);
  drawKicker(kicker, x, 16, HUE);

  sprite.setFreeFont(&FreeSansBold18pt7b);
  if (sprite.textWidth(h1) + 1 > colW || sprite.textWidth(h2) + 1 > colW) sprite.setFreeFont(&FreeSansBold12pt7b);
  drawHeavy(h1, x, 40, INK);
  drawHeavy(h2, x, 72, INK);

  drawBody(small, x, 104, INK_2);

  // Pillen: koden med bokstäverna lite isär, eller ett längre namn i mindre stil.
  const int pillCy = 145, pillH = 32;
  sprite.setFreeFont(&FreeSansBold12pt7b);
  const int len = strlen(pillText);
  int track = 3;
  int total = 0;
  char ch[2] = {0, 0};
  for (int i = 0; i < len; i++) { ch[0] = pillText[i]; total += sprite.textWidth(ch) + (i ? track : 0); }
  if (total > colW - 20) {
    // Ett långt namn (nätets): pillen går ut till skärmkanten, texten i 9 pt.
    const int px = x - 6, pw = SCREEN_W - 4 - px;
    drawPill(px + pw / 2, pillCy, pw, pillH, SURF, LINE);
    sprite.setFreeFont(&FreeSansBold9pt7b);
    if (sprite.textWidth(pillText) > pw - 20) sprite.setFreeFont(&FreeSans9pt7b);
    sprite.setTextDatum(MC_DATUM);
    sprite.setTextColor(INK);
    sprite.drawString(pillText, px + pw / 2, pillCy);
  } else {
    drawPill(x + colW / 2, pillCy, colW, pillH, SURF, LINE);
    sprite.setTextColor(INK);
    int cx = x + (colW - total) / 2;
    sprite.setTextDatum(ML_DATUM);
    for (int i = 0; i < len; i++) {
      ch[0] = pillText[i];
      sprite.drawString(ch, cx, pillCy);
      cx += sprite.textWidth(ch) + track;
    }
  }
  pushFrame();
}

// Ny tagg: QR-koden till appen, och koden att skriva in.
void renderPairing() {
  renderQrPanel(pairUrl[0] ? pairUrl : PAIR_URL_FALLBACK,
                "NEW TAG", "SCAN TO", "PAIR", "Or type the code:", pairCode);
}

// Inget känt WiFi: QR-koden ansluter mobilen till lådans eget nät, och där
// dyker inställningssidan upp av sig själv.
void renderWifiSetup() {
  char qr[64];
  snprintf(qr, sizeof(qr), "WIFI:T:nopass;S:%s;;", apName);
  renderQrPanel(qr, "NO WIFI", "SCAN TO", "SET UP",
                wifiSetupResult == 3 ? "Wrong password?" : "Or join the WiFi:", apName);
}

// Taggen registrerades medan QR-koden stod kvar.
void renderPaired() {
  sprite.fillSprite(BG);
  drawRing(CENTER_X, 46, 22, 5, GREEN);
  drawCheck(CENTER_X, 46, 22, 6, 1.0, GREEN);
  String n = String(pairedName);
  n.toUpperCase();
  if (n.length() > 14) n = n.substring(0, 14);
  String hi = String("HI, ") + n;
  sprite.setTextDatum(MC_DATUM);
  fitHeadline(hi, SCREEN_W - 32);
  drawHeavy(hi, CENTER_X, 100, INK);
  drawBody("Tag paired. Phone in to start.", CENTER_X, 140, INK_2);
  pushFrame();
}

// Inställningen gick igenom.
void renderWifiOk() {
  sprite.fillSprite(BG);
  drawRing(CENTER_X, 52, 24, 5, GREEN);
  drawCheck(CENTER_X, 52, 24, 6, 1.0, GREEN);
  sprite.setTextDatum(MC_DATUM);
  sprite.setFreeFont(&FreeSansBold18pt7b);
  drawHeavy("CONNECTED", CENTER_X, 108, INK);
  drawBody(connectedSsid, CENTER_X, 142, INK_2);
  pushFrame();
}

// IDLE visar det taggen säger: inget, kollar, hej, QR eller ingen anslutning.
// Utan tagg och utan WiFi visar den hur lådan ställs in. QR-bilderna ritas
// om bara när innehållet byts — de räknas inte fram 30 gånger i sekunden.
char lastDrawnQr[64] = "";

// Ritar en QR-skärm bara om nyckeln är ny.
bool qrNeedsDraw(const char* key) {
  if (strcmp(lastDrawnQr, key) == 0) return false;
  strncpy(lastDrawnQr, key, sizeof(lastDrawnQr) - 1);
  lastDrawnQr[sizeof(lastDrawnQr) - 1] = 0;
  return true;
}

void renderIdle() {
  if (!tagPresent || tagInfo == TI_NONE) {
    if (pairedShownAt != 0) { lastDrawnQr[0] = 0; renderPaired(); return; }
    if (pairHold && pairCode[0]) {
      char key[24];
      snprintf(key, sizeof(key), "pair:%s", pairCode);   // samma nyckel: ingen omritning vid lyftet
      if (qrNeedsDraw(key)) renderPairing();
      return;
    }
    if (wifiSetupResult == 2 && wifiOkShownAt != 0) { lastDrawnQr[0] = 0; renderWifiOk(); return; }
    if (portalActive && !wifiUp) {
      char key[48];
      snprintf(key, sizeof(key), "wifi:%s:%d", apName, wifiSetupResult == 3 ? 3 : 0);
      if (qrNeedsDraw(key)) renderWifiSetup();
      return;
    }
    lastDrawnQr[0] = 0;
    renderLogo();
    return;
  }
  switch (tagInfo) {
    case TI_PENDING:
      lastDrawnQr[0] = 0;
      renderChecking();
      break;
    case TI_KNOWN:
      lastDrawnQr[0] = 0;
      renderHello();
      break;
    case TI_UNKNOWN: {
      char key[24];
      snprintf(key, sizeof(key), "pair:%s", pairCode);
      if (qrNeedsDraw(key)) renderPairing();
      break;
    }
    case TI_OFFLINE:
      lastDrawnQr[0] = 0;
      renderOffline();
      break;
    default:
      renderLogo();
  }
}

// Pausen som pågår: märket och dess gloria, inget annat. Locket är stängt.
void drawActiveMark(float k) {
  drawHalo(CENTER_X, CENTER_Y, 78, k);
  drawPauseMark(CENTER_X, CENTER_Y, 64, fadeIn(C_ACCENT, k));
}

// Startceremonin: grön bock (lådans bekräftelse) → CLOCK ON. → 00:01–00:05
// → märket tonar in. Klockan går redan under ceremonin.
void renderCheckedIn() {
  sprite.fillSprite(BG);
  unsigned long t = millis() - phaseStartMs;
  sprite.setTextDatum(MC_DATUM);

  if (t < CER_CHECK_END) {
    float draw = t / (float)CHECK_DRAW_MS;
    float fade = 1.0;
    unsigned long left = CER_CHECK_END - t;
    if (left < CHECK_FADE_MS) fade = left / (float)CHECK_FADE_MS;
    uint16_t g = fadeIn(C_GREEN, fade);
    drawRing(CENTER_X, CENTER_Y, RING_R, 6, g);
    drawCheck(CENTER_X, CENTER_Y, RING_R, 9, draw, g);
  } else if (t < CER_TEXT_END) {
    float u = (t - CER_CHECK_END) / (float)STARTED_TEXT_MS;
    float k = (u < 0.2) ? u / 0.2 : ((u > 0.8) ? (1.0 - u) / 0.2 : 1.0);
    sprite.setFreeFont(&FreeSansBold24pt7b);
    drawHeavy("CLOCK ON.", CENTER_X, CENTER_Y, fadeIn(C_INK, k));
  } else if (t < CER_FADE_END) {
    unsigned long ct = t - CER_TEXT_END;
    int n;
    float k;
    if (t < CER_COUNT_END) {
      n = ct / 1000 + 1;
      if (n > COUNT_SECONDS) n = COUNT_SECONDS;
      float within = (ct % 1000) / 1000.0;
      k = (within < 0.15) ? within / 0.15 : 1.0;
    } else {
      n = COUNT_SECONDS;
      k = 1.0 - (t - CER_COUNT_END) / (float)COUNT_FADE_MS;
    }
    sprite.setFreeFont(&FreeSansBold24pt7b);
    drawHeavy(formatDuration(n * 1000UL), CENTER_X, CENTER_Y, fadeIn(C_INK, k));
  } else {
    float k = (t - CER_FADE_END) / (float)LOGO_FADE_MS;
    if (k > 1.0) k = 1.0;
    drawActiveMark(k);
  }
  pushFrame();
}

// Appens flöde: två steg, och en mätare av två staplar som säger var man är.
void renderAwaitingLid() {
  sprite.fillSprite(BG);
  const int segW = 26, segH = 6, segGap = 8;
  int sx = CENTER_X - segW - segGap / 2;
  sprite.fillSmoothRoundRect(sx, 22, segW, segH, segH / 2, HUE);
  sprite.fillSmoothRoundRect(sx + segW + segGap, 22, segW, segH, segH / 2, phonePlaced ? HUE : LINE);

  sprite.setTextDatum(MC_DATUM);
  sprite.setFreeFont(&FreeSansBold24pt7b);
  drawHeavy(phonePlaced ? "LID DOWN." : "PHONE IN.", CENTER_X, 82, INK);
  drawBody(phonePlaced ? "Clock starts then." : "Tag on the mark.", CENTER_X, 132, INK_2);
  pushFrame();
}

void renderActive() {
  sprite.fillSprite(BG);
  drawActiveMark(1.0);
  pushFrame();
}

// Locket öppet: klockan står, och fristen rinner ur en rad staplar — en per
// sekund, samma form som märket.
void renderRespite() {
  sprite.fillSprite(BG);
  unsigned long since = millis() - respiteStartMs;
  unsigned long left  = (since >= RESPITE_MS) ? 0 : (RESPITE_MS - since);

  sprite.setTextDatum(MC_DATUM);
  drawKicker("ON HOLD", CENTER_X, 20, HONEY);
  sprite.setFreeFont(&FreeSansBold24pt7b);
  drawHeavy(formatDuration(elapsedMs()), CENTER_X, 64, INK);

  const int bars = RESPITE_MS / 1000;
  const int bw = 5, bh = 18, bgap = 3;
  int total = bars * bw + (bars - 1) * bgap;
  int x = (SCREEN_W - total) / 2;
  float remaining = left / 1000.0;
  for (int i = 0; i < bars; i++) {
    float k = remaining - i;                 // 1 = full stapel, 0 = tom
    uint16_t c = (k >= 1.0) ? HUE : (k <= 0.0 ? LINE : mix(C_LINE, C_HUE, k));
    sprite.fillSmoothRoundRect(x + i * (bw + bgap), 102, bw, bh, 2, c);
  }
  drawBody("Lid down to go on.", CENTER_X, 146, INK_2);
  pushFrame();
}

// Klar: tiden, i honung och grädde. Rekordet får en honungsfylld pill med
// marinblå text (designsystemet: mörk text på honung).
void renderEnded() {
  sprite.fillSprite(BG);
  sprite.setTextDatum(MC_DATUM);
  drawKicker("PAUSE DONE", CENTER_X, 26, HONEY);
  sprite.setFreeFont(&FreeSansBold24pt7b);
  drawHeavy(formatDuration(endedDurationMs), CENTER_X, 76, INK);
  if (endedWasRecord) {
    sprite.setFreeFont(&FreeSansBold9pt7b);
    int w = sprite.textWidth("LONGEST YET") + 36;
    drawPill(CENTER_X, 128, w, 30, HONEY, HONEY);
    sprite.setTextColor(BG);
    sprite.drawString("LONGEST YET", CENTER_X, 128);
  }
  pushFrame();
}

// ─── Sessionslogik ──────────────────────────────────────────

// Startar klockan. Bara en app-paus berättar det för appen.
void startSession(Owner owner) {
  sessionOwner = owner;
  if (owner == OWNER_TAG) strncpy(sessionTagUid, tagUid, sizeof(sessionTagUid));
  else sessionTagUid[0] = 0;

  activeSeq = nextSeq++;
  prefs.putUInt("next_seq", nextSeq);
  sessionAccumMs   = 0;
  sessionSegmentMs = millis();
  lastCheckpointMs = millis();
  playStartTone();
  if (owner == OWNER_APP) sendBLE("session_started:%lu", (unsigned long)activeSeq);
  Serial.printf("Session %lu startad (%s)\n", (unsigned long)activeSeq,
                owner == OWNER_TAG ? sessionTagUid : "app");
  setPhase(CHECKED_IN);
}

void endSession(bool completed) {
  unsigned long dur = elapsedMs();
  sessionAccumMs = dur;
  Owner owner = sessionOwner;

  if (dur < MIN_SESSION_MS) {
    Serial.println("Session för kort, kastas");
    prefs.remove("cp_seq");
    activeSeq = 0;
    sessionOwner = OWNER_NONE;
    setPhase(IDLE);
    return;
  }

  endedWasRecord = (dur > statLongestMs);

  if (owner == OWNER_TAG) {
    WifiRecord w;
    w.seq = activeSeq;
    w.durationMs = dur;
    w.endedAtMillis = millis();
    w.completed = completed ? 1 : 0;
    strncpy(w.tagUid, sessionTagUid, sizeof(w.tagUid));
    wifiQueuePush(w);
    lastUploadTryMs = 0;   // försök direkt
  } else {
    SessionRecord r;
    r.seq           = activeSeq;
    r.durationMs    = dur;
    r.endedAtMillis = millis();
    r.completed     = completed ? 1 : 0;
    queuePush(r);
    sendBLE("session_ended:%lu:%lu:%d:0",
            (unsigned long)r.seq, (unsigned long)r.durationMs, r.completed);
  }

  statTotalMs += dur;
  statLatestMs = dur;
  if (endedWasRecord) statLongestMs = dur;
  statCount++;
  saveStats();
  prefs.remove("cp_seq");

  Serial.printf("Session %lu slut: %lu ms, completed=%d\n",
                (unsigned long)activeSeq, dur, completed ? 1 : 0);
  endedDurationMs = dur;
  activeSeq = 0;
  sessionOwner = OWNER_NONE;
  setPhase(ENDED);
  playEndTone();
}

void checkpoint() {
  prefs.putUInt("cp_seq", activeSeq);
  prefs.putUInt("cp_ms", elapsedMs());
  prefs.putUChar("cp_owner", (uint8_t)sessionOwner);
  prefs.putString("cp_tag", sessionTagUid);
  lastCheckpointMs = millis();
}

void recoverCheckpoint() {
  uint32_t cpSeq = prefs.getUInt("cp_seq", 0);
  if (cpSeq == 0) return;
  uint32_t cpMs = prefs.getUInt("cp_ms", 0);
  Owner owner = (Owner)prefs.getUChar("cp_owner", OWNER_APP);
  String tag = prefs.getString("cp_tag", "");
  Serial.printf("Återställer avbruten session %lu\n", (unsigned long)cpSeq);
  if (cpMs >= MIN_SESSION_MS) {
    if (owner == OWNER_TAG && tag.length() > 0) {
      WifiRecord w;
      w.seq = cpSeq; w.durationMs = cpMs; w.endedAtMillis = 0; w.completed = 0;
      strncpy(w.tagUid, tag.c_str(), sizeof(w.tagUid));
      w.tagUid[sizeof(w.tagUid) - 1] = 0;
      wifiQueuePush(w);
    } else {
      SessionRecord r;
      r.seq = cpSeq; r.durationMs = cpMs; r.endedAtMillis = 0; r.completed = 0;
      queuePush(r);
    }
    statTotalMs += cpMs;
    statLatestMs = cpMs;
    if (cpMs > statLongestMs) statLongestMs = cpMs;
    statCount++;
    saveStats();
  }
  prefs.remove("cp_seq");
}

// ─── Backlog (Bluetooth, app-pauser) ────────────────────────

void sendNextBacklog() {
  if (!deviceConnected || queueCount == 0) { backlogSending = false; return; }
  SessionRecord& r = queueBuf[0];
  backlogSending  = true;
  backlogAwaitSeq = r.seq;
  backlogSentAt   = millis();
  unsigned long ago = r.endedAtMillis > 0 ? (millis() - r.endedAtMillis) : 0;
  sendBLE("session_ended:%lu:%lu:%d:%lu",
          (unsigned long)r.seq, (unsigned long)r.durationMs, r.completed, ago);
}

// ─── BLE-callbacks ──────────────────────────────────────────

class CharCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) {
    portENTER_CRITICAL(&bleValueMux);
    String msg = c->getValue().c_str();
    portEXIT_CRITICAL(&bleValueMux);
    msg.trim();
    Serial.printf("← \"%s\"\n", msg.c_str());
    lastActivityMs = millis();   // appen vill något: väck skärmen

    if (msg.startsWith("session_ack:")) { pendingAckSeq = msg.substring(12).toInt(); return; }
    if (msg.startsWith("phone_down"))   { pendingPhoneDown = true; return; }
    if (msg.startsWith("phone_up"))     { pendingPhoneUp = true; return; }
    if (msg.startsWith("set_mode:"))    { pendingSetMode = true; return; }
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) {
    deviceConnected = true;
    Serial.println("App ansluten");
  }
  void onDisconnect(BLEServer* s) {
    deviceConnected = false;
    backlogSending = false;
    backlogStartAt = 0;
    handshakeAt = 0;
    Serial.println("App frånkopplad");
    BLEDevice::startAdvertising();
  }
};

void onConnectedHandshake() {
  sendBLE("hello:%s", boxIdBle.c_str());
  delay(20);
  sendBLE("state:%s:%lu:%lu", phaseName(phase),
          sessionOwner == OWNER_TAG ? 0UL : (unsigned long)elapsedMs(),
          sessionOwner == OWNER_TAG ? 0UL : (unsigned long)activeSeq);
  delay(20);
  sendBLE("battery:%d", batteryPercent());
  lastBatteryReport = millis();
  backlogStartAt = millis() + BACKLOG_START_MS;
}

// ─── Locket ─────────────────────────────────────────────────

void handleLid() {
  bool raw = digitalRead(LID_PIN) == LOW;
  unsigned long now = millis();

  if (raw != lastLidRaw) { lastLidChangeMs = now; lastLidRaw = raw; }
  if (now - lastLidChangeMs < DEBOUNCE_MS) return;
  if (raw == lidClosed) return;

  lidClosed = raw;
  lastActivityMs = now;
  // Lock-händelser är appens bara när appen äger (eller kan komma att äga)
  // pausen. Under en NFC-paus, eller på loggan, säger de appen ingenting
  // den ska agera på.
  bool tellApp = (sessionOwner == OWNER_APP) || phase == AWAITING_LID;

  if (lidClosed) {
    if (tellApp) sendBLE("lid_closed");

    // Locket på = klar med lådan. En kvarstående QR-kod försvinner.
    if (pairHold) {
      pairHold = false;
      pairCode[0] = 0;
      Serial.println("QR-koden borttagen (locket stängt)");
    }

    if (phase == RESPITE) {
      if (sessionOwner == OWNER_TAG && !tagPresent) {
        // Telefonen togs ur och locket stängdes över en tom låda.
        endSession(true);
      } else {
        sessionSegmentMs = millis();
        setPhase(ACTIVE);
        rfid.PCD_AntennaOff();   // spar ström tills locket öppnas igen
      }
    } else if (phase == AWAITING_LID) {
      // Appens paus: inga tummar längre, så locket är incheckningen.
      // Samma ordning som v7 skickade när tummarna höll färdigt.
      sendBLE("checkin_complete");
      delay(20);
      startSession(OWNER_APP);
    } else if (phase == IDLE && tagPresent) {
      // Lådans egen paus: en känd tagg ligger i lådan och locket stängdes.
      // Bara en stängning räknas, inte ett lock som redan var stängt vid
      // start — så en omstart med telefonen i lådan startar ingen paus.
      if (tagInfo == TI_KNOWN) startSession(OWNER_TAG);
      else if (tagInfo == TI_PENDING || tagInfo == TI_OFFLINE) startWhenKnown = true;
    }
  } else {
    if (tellApp) sendBLE("lid_opened");
    startWhenKnown = false;
    if (sessionRunning()) {
      sessionAccumMs += millis() - sessionSegmentMs;
      respiteStartMs = millis();
      rfid.PCD_AntennaOn();
      tagLastSeenMs = millis();   // ge läsaren en stund att se taggen igen
      setPhase(RESPITE);
    }
  }
}

// ─── Taggen ─────────────────────────────────────────────────

void onTagArrived() {
  Serial.printf("Tagg: %s\n", tagUid);
  lastActivityMs = millis();
  pairHold = false;        // en telefon i lådan går före en kvarstående QR-kod
  pairedShownAt = 0;
  tagInfo = TI_PENDING;
  tagOwnerName[0] = 0;
  pairCode[0] = 0;
  requestLookup(tagUid);
}

void onTagGone() {
  Serial.println("Taggen borta");
  lastActivityMs = millis();
  startWhenKnown = false;
  // Under en NFC-paus med öppet lock = telefonen lyftes ur → klar.
  if (phase == RESPITE && sessionOwner == OWNER_TAG) endSession(true);
  // Okänd tagg: låt QR-koden stå kvar så att den går att skanna.
  if (phase == IDLE && tagInfo == TI_UNKNOWN && pairCode[0]) {
    pairHold = true;
    strncpy(pairHoldUid, tagUid, sizeof(pairHoldUid));
    pairHoldUntil = millis() + PAIR_HOLD_MS;
    Serial.println("QR-koden står kvar medan någon skannar");
    tagInfo = TI_NONE;
    tagOwnerName[0] = 0;
    return;   // pairCode och pairUrl behålls
  }
  tagInfo = TI_NONE;
  tagOwnerName[0] = 0;
  pairCode[0] = 0;
}

void pollTag() {
  unsigned long now = millis();
  // Locket stängt under en paus: telefonen kan inte tas ur, så läsaren vilar
  // med antennen avslagen (se handleLid). Taggen räknas som kvar.
  if (phase == ACTIVE && lidClosed) return;
  if (now - lastReaderCheckMs > READER_CHECK_MS) {
    lastReaderCheckMs = now;
    if (!readerOk()) {
      Serial.printf("Läsaren svarar inte rätt (version 0x%02X, antenn 0x%02X), startar om den\n",
                    rfid.PCD_ReadRegister(MFRC522::VersionReg),
                    rfid.PCD_ReadRegister(MFRC522::TxControlReg));
      startReader();
      tagLastSeenMs = millis();   // omstarten tappar taggen en stund
    } else if (!tagPresent) {
      // Ingen tagg på läsaren: starta om den tyst ändå. Läsaren kan fastna i
      // ett läge där inga register ser fel ut men ingen tagg läses — en
      // omstart löser det, och utan tagg finns inget att tappa. RST-sladden
      // till GPIO 16 gör samma sak hårdare om den sitter i.
      startReaderQuiet();
    }
  }

  if (now - lastTagPollMs < TAG_POLL_MS) return;
  lastTagPollMs = now;

  char uid[21];
  // En miss provas om direkt: kopiorna svarar ofta varannan gång.
  bool seen = readTagOnce(uid) || readTagOnce(uid);

  if (seen) {
    tagLastSeenMs = now;
    if (!tagPresent || strcmp(uid, tagUid) != 0) {
      bool replaced = tagPresent;
      strncpy(tagUid, uid, sizeof(tagUid));
      tagPresent = true;
      if (replaced) Serial.println("Annan tagg");
      onTagArrived();
    }
  } else if (tagPresent && now - tagLastSeenMs > TAG_GONE_MS) {
    tagPresent = false;
    onTagGone();
  }
}

// Svaret från box-tag, och omfrågningar medan QR visas eller nätet är nere.
void handleLookup() {
  unsigned long now = millis();

  if (lookupDone) {
    lookupDone = false;
    char uid[21], status[12], name[33], code[11], url[96];
    bool ok;
    xSemaphoreTake(netMutex, portMAX_DELAY);
    strncpy(uid, lookupResultUid, sizeof(uid));
    ok = lookupOk;
    strncpy(status, lookupStatus, sizeof(status));
    strncpy(name, lookupName, sizeof(name));
    strncpy(code, lookupCode, sizeof(code));
    strncpy(url, lookupUrl, sizeof(url));
    xSemaphoreGive(netMutex);

    // Svar för den kvarstående QR-koden: har någon registrerat taggen?
    if (!tagPresent && pairHold && strcmp(uid, pairHoldUid) == 0) {
      if (ok && strcmp(status, "known") == 0) {
        pairHold = false;
        pairCode[0] = 0;
        strncpy(pairedName, name, sizeof(pairedName));
        pairedShownAt = now;
        Serial.printf("Taggen registrerad: %s\n", pairedName);
      } else if (ok && strcmp(status, "unknown") == 0) {
        strncpy(pairCode, code, sizeof(pairCode));   // en ny kod om den gamla gått ut
        strncpy(pairUrl, url, sizeof(pairUrl));
      }
      // Inget svar: koden står kvar, nästa fråga om en stund.
    }

    // Svar för en tagg som inte längre ligger där → släng.
    if (tagPresent && strcmp(uid, tagUid) == 0) {
      if (!ok) {
        tagInfo = TI_OFFLINE;
      } else if (strcmp(status, "known") == 0) {
        bool wasKnown = (tagInfo == TI_KNOWN);
        tagInfo = TI_KNOWN;
        strncpy(tagOwnerName, name, sizeof(tagOwnerName));
        if (!wasKnown) Serial.printf("Känd tagg: %s\n", tagOwnerName);
      } else if (strcmp(status, "unknown") == 0) {
        tagInfo = TI_UNKNOWN;
        strncpy(pairCode, code, sizeof(pairCode));
        strncpy(pairUrl, url, sizeof(pairUrl));
      } else {
        tagInfo = TI_OFFLINE;
      }

      // Locket stängdes medan svaret var på väg.
      if (startWhenKnown && phase == IDLE && lidClosed && tagInfo == TI_KNOWN) {
        startWhenKnown = false;
        startSession(OWNER_TAG);
      }
    }
  }

  // Den kvarstående QR-koden: släpp den när tiden gått ut eller lådan börjat
  // något annat, och fråga annars servern med jämna mellanrum.
  if (pairHold && (phase != IDLE || (long)(now - pairHoldUntil) >= 0)) {
    pairHold = false;
    pairCode[0] = 0;
    Serial.println("QR-koden borttagen");
  }
  if (pairHold && !tagPresent && !lookupRequested && now - lastLookupMs > PAIR_POLL_MS) {
    requestLookup(pairHoldUid);
  }
  if (pairedShownAt != 0 && now - pairedShownAt > PAIRED_SHOW_MS) pairedShownAt = 0;

  // Fråga igen: QR visas (har någon registrerat taggen?) eller nätet var nere.
  if (phase == IDLE && tagPresent && !lookupRequested) {
    if ((tagInfo == TI_UNKNOWN && now - lastLookupMs > PAIR_POLL_MS) ||
        (tagInfo == TI_OFFLINE && now - lastLookupMs > LOOKUP_RETRY_MS)) {
      requestLookup(tagUid);
    }
  }
}

// NFC-pauser till servern, en i taget, äldst först.
void handleUploads() {
  unsigned long now = millis();

  if (uploadDone) {
    uploadDone = false;
    uploadBusy = false;
    int result;
    uint32_t seq;
    xSemaphoreTake(netMutex, portMAX_DELAY);
    result = uploadResult;
    seq = uploadRec.seq;
    xSemaphoreGive(netMutex);
    if (result == 1) {
      wifiQueueRemoveSeq(seq);
      lastUploadTryMs = 0;   // nästa i kön direkt
    }
  }

  // Ett uppslag går före — det är någon som står vid lådan och väntar.
  if (uploadBusy || wifiQueueCount == 0 || lookupRequested) return;
  if (lastUploadTryMs != 0 && now - lastUploadTryMs < UPLOAD_RETRY_MS) return;

  lastUploadTryMs = now;
  uploadBusy = true;
  xSemaphoreTake(netMutex, portMAX_DELAY);
  uploadRec = wifiQueue[0];
  uploadAgoMs = wifiQueue[0].endedAtMillis > 0 ? (now - wifiQueue[0].endedAtMillis) : 0;
  xSemaphoreGive(netMutex);
  uploadDone = false;
  uploadRequested = true;
}

// ─── Setup / Loop ───────────────────────────────────────────

// ─── Viloläge ───────────────────────────────────────────────
//
// Två nivåer, för att lådan går på batteri:
//
// 1. DJUPSÖMN när locket varit stängt i 30 s utan att en paus pågår. Allt
//    stängs av utom en liten krets som vakar över locksensorn (GPIO 1). När
//    locket öppnas vaknar lådan och startar om från början: startskärmen
//    syns inom någon sekund, WiFi och Bluetooth är uppe några sekunder
//    senare. En paus kan inte startas medan den sover, men den kan inte
//    heller börja förrän locket öppnats och en telefon lagts i.
//
// 2. SKÄRMVILA när locket stått öppet i 5 minuter utan att något hänt.
//    Bara skärmen och bakgrundsljuset släcks; läsaren, WiFi och Bluetooth
//    är kvar, så en telefon i lådan, locket eller appen väcker skärmen
//    direkt. Djupsömn går inte här: med locket öppet finns ingen händelse
//    att vakna på, och lådan måste kunna se en tagg.
//
// Under en pågående paus sover lådan aldrig: klockan går i chipet.
//
// GPIO 15 (skärm och batterikrets) hålls PÅ under djupsömnen. Enligt
// LilyGO-forumet styr den också batterikretsen, och stängdes den av kunde
// kortet tappa strömmen helt på batteri — då vaknar det aldrig. Skärmen
// stängs i stället av med sina egna kommandon. Det kostar lite ström, men
// lådan kan inte råka stänga av sig själv.

#define LCD_BL_PIN 38

const unsigned long SLEEP_LID_CLOSED_MS   = 30000;   // locket stängt, inget händer → djupsömn
const unsigned long SCREEN_IDLE_MS        = 300000;  // locket öppet, inget händer → skärmvila
const unsigned long SLEEP_UPLOAD_GRACE_MS = 60000;   // pauser i kön: försök skicka så här länge först
const unsigned long SLEEP_OFFLINE_START_MS = 120000; // locket stängdes medan servern inte svarat

bool          screenOff      = false;
unsigned long screenOffSince = 0;

// ── Bakgrundsljusets styrka ──
//
// T-Display S3 har en LED-drivare (AW9364) med 16 steg. Steget ställs med
// korta pulser på GPIO 38 och ligger sedan kvar i drivaren så länge pinnen
// står hög — också när processorn sover djupt. Därför kan paustecknet lysa
// nedtonat genom hela pausdvalan: skärmen minns bilden själv, drivaren
// minns ljuset, och processorn behöver inte vara vaken för någotdera.
// (PWM med analogWrite fungerar inte i djupsömn, pulserna gör det.)
const uint8_t BL_STEPS          = 16;
const uint8_t PAUSE_SCREEN_LEVEL = 2;   // steg av 16 under pausdvalan
uint8_t blLevel = BL_STEPS;              // tft.init() tänder ljuset fullt

void setBacklightLevel(uint8_t level) {
  if (level > BL_STEPS) level = BL_STEPS;
  if (level == 0) {
    digitalWrite(LCD_BL_PIN, LOW);
    delay(3);                            // drivaren nollställs efter >2,5 ms låg
    blLevel = 0;
    return;
  }
  if (blLevel == 0) {
    digitalWrite(LCD_BL_PIN, HIGH);
    delayMicroseconds(30);
    blLevel = BL_STEPS;
  }
  int from = BL_STEPS - blLevel;
  int to   = BL_STEPS - level;
  int num  = (BL_STEPS + to - from) % BL_STEPS;
  for (int i = 0; i < num; i++) {
    digitalWrite(LCD_BL_PIN, LOW);
    digitalWrite(LCD_BL_PIN, HIGH);
  }
  blLevel = level;
}

// Sätts av hibernatePause(): djupsömnen ska lämna skärmen tänd.
bool sleepKeepScreen = false;

// ── Pausdvala ──
//
// En NFC-paus med stängt lock behöver ingenting förrän locket öppnas: ingen
// tittar på skärmen, telefonen kan inte tas ur, och pausen laddas upp först
// när den är slut. Därför sover lådan i djupsömn också under pausen. Tiden
// räknas med chippets RTC-klocka, som går genom djupsömnen; pausens läge
// sparas i RTC-minnet (överlever djupsömn, inte strömavbrott — för det finns
// NVS-checkpointen, som skrivs innan lådan somnar).
//
// När locket öppnas vaknar lådan, räknar ihop tiden och går direkt till
// ON HOLD, som om den varit vaken hela tiden. Lyfts telefonen ur slutar
// pausen som vanligt. RTC-klockan kan dra sig någon procent, så en
// flertimmarspaus kan skilja någon minut.
//
// Appens pauser sover inte: appen behöver Bluetooth hela vägen.
//
// Skärmen står kvar under dvalan med paustecknet på nedtonat ljus
// (PAUSE_SCREEN_LEVEL), så att man ser att pausen pågår. Det drar några mA
// mot under 1 mA med skärmen av — se setBacklightLevel().
const unsigned long PAUSE_SLEEP_AFTER_MS = 20000;   // pausmärket syns en stund först
const uint32_t SLEEP_PAUSE_MAGIC = 0x50415553;     // "PAUS"

struct SleepPause {
  uint32_t magic;
  uint32_t seq;
  uint32_t accumMs;
  int64_t  sleptAtUs;
  char     tagUid[21];
};
RTC_DATA_ATTR SleepPause sleepPause = {0, 0, 0, 0, ""};

bool          restoredFromPauseSleep = false;
unsigned long restoredAtMs           = 0;

int64_t rtcNowUs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (int64_t)tv.tv_sec * 1000000LL + tv.tv_usec;
}

void screenSleep() {
  tft.writecommand(TFT_DISPOFF);
  tft.writecommand(TFT_SLPIN);
  setBacklightLevel(0);
  screenOff = true;
  screenOffSince = millis();
  Serial.println("Skärmvila");
}

void screenWake() {
  tft.writecommand(TFT_SLPOUT);
  delay(120);                       // ST7789 behöver 120 ms efter SLPOUT
  tft.writecommand(TFT_DISPON);
  setBacklightLevel(BL_STEPS);
  screenOff = false;
  lastDrawnQr[0] = 0;               // rita om allt, också en QR-kod
  Serial.println("Skärmen vaken");
}

void goToDeepSleep() {
  Serial.printf("Djupsömn. Vaknar när locket öppnas. Batteri %d%%\n", batteryPercent());

  // Läsaren: mjuk power-down, och RST låg om sladden sitter på GPIO 16
  // (hård power-down, nästan ingen ström). Sitter RST på 3.3V gör det inget.
  rfid.PCD_SoftPowerDown();
  digitalWrite(RC522_RST_PIN, LOW);

  if (sleepKeepScreen) {
    // Pausdvala: skärmen står kvar med paustecknet och nedtonat ljus. Dess
    // styrpinnar hålls i viloläge så att inget brus når den under sömnen
    // (RST låg hade tömt den, CS låg hade kunnat skriva skräp i bilden).
    const int lcdPins[] = {TFT_CS, TFT_RST, TFT_WR, TFT_RD, TFT_DC};
    for (int p : lcdPins) {
      digitalWrite(p, HIGH);
      gpio_hold_en((gpio_num_t)p);
    }
  } else {
    // Skärmen av med egna kommandon, bakgrundsljuset av.
    tft.writecommand(TFT_DISPOFF);
    tft.writecommand(TFT_SLPIN);
    setBacklightLevel(0);
  }

  // Håll pinnarnas lägen genom sömnen (annars flyter de och läcker ström).
  gpio_hold_en((gpio_num_t)LCD_BL_PIN);
  gpio_hold_en((gpio_num_t)POWER_PIN);
  gpio_hold_en((gpio_num_t)RC522_RST_PIN);
  gpio_deep_sleep_hold_en();

  // Vakna när locket öppnas: reed-switchen släpper, GPIO 1 går HIGH.
  rtc_gpio_pullup_en((gpio_num_t)LID_PIN);
  rtc_gpio_pulldown_dis((gpio_num_t)LID_PIN);
  esp_sleep_enable_ext0_wakeup((gpio_num_t)LID_PIN, 1);

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  Serial.flush();
  delay(50);
  esp_deep_sleep_start();
}

// Släpper det goToDeepSleep() höll fast. Körs först i setup().
void releaseSleepHolds() {
  gpio_deep_sleep_hold_dis();
  gpio_hold_dis((gpio_num_t)LCD_BL_PIN);
  gpio_hold_dis((gpio_num_t)POWER_PIN);
  gpio_hold_dis((gpio_num_t)RC522_RST_PIN);
  const int lcdPins[] = {TFT_CS, TFT_RST, TFT_WR, TFT_RD, TFT_DC};
  for (int p : lcdPins) gpio_hold_dis((gpio_num_t)p);
  if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) {
    rtc_gpio_deinit((gpio_num_t)LID_PIN);   // tillbaka till vanlig GPIO
    Serial.println("Vaknade: locket öppnades");
  }
}

void hibernatePause() {
  checkpoint();                       // om batteriet skulle dö under sömnen
  sleepPause.seq       = activeSeq;
  sleepPause.accumMs   = elapsedMs();
  sleepPause.sleptAtUs = rtcNowUs();
  strncpy(sleepPause.tagUid, sessionTagUid, sizeof(sleepPause.tagUid));
  sleepPause.magic     = SLEEP_PAUSE_MAGIC;
  // Paustecknet står kvar, nedtonat, genom hela sömnen.
  renderActive();
  setBacklightLevel(PAUSE_SCREEN_LEVEL);
  sleepKeepScreen = true;
  Serial.printf("Pausdvala: session %lu, %lu ms hittills\n",
                (unsigned long)activeSeq, (unsigned long)sleepPause.accumMs);
  goToDeepSleep();
}

// Körs sist i setup() när lådan vaknade ur pausdvalan: tillbaka till pausen,
// med locket öppet alltså ON HOLD.
void restorePauseFromSleep() {
  int64_t sleptMs = (rtcNowUs() - sleepPause.sleptAtUs) / 1000;
  if (sleptMs < 0) sleptMs = 0;
  sessionOwner = OWNER_TAG;
  activeSeq    = sleepPause.seq;
  strncpy(sessionTagUid, sleepPause.tagUid, sizeof(sessionTagUid));
  sessionAccumMs = sleepPause.accumMs + (uint32_t)sleptMs;
  sleepPause.magic = 0;
  restoredFromPauseSleep = true;
  restoredAtMs = millis();
  if (lidClosed) {                    // väckt på annat sätt med locket stängt
    sessionSegmentMs = millis();
    setPhase(ACTIVE);
  } else {
    respiteStartMs = millis();
    setPhase(RESPITE);
  }
  Serial.printf("Vaknade ur pausdvalan: session %lu, sov %lld s, %lu ms totalt\n",
                (unsigned long)activeSeq, sleptMs / 1000, (unsigned long)sessionAccumMs);
}

// Får lådan sova nu? Bara när den står på startskärmen och inget väntar.
bool readyForSleep(unsigned long now) {
  if (phase != IDLE) return false;
  if (lookupRequested || uploadBusy) return false;   // ett nätverksanrop pågår
  if (phoneOnPortal()) return false;                 // någon ställer in WiFi
  if (pairedShownAt != 0) return false;              // "HI, NAMN" står på skärmen
  return true;
}

void handleSleep() {
  unsigned long now = millis();
  unsigned long idleFor = now - lastActivityMs;

  // Efter pausdvalan: läsaren hann inte se taggen före lyftet → telefonen
  // togs ur direkt när locket öppnades. Samma sak som att lyfta den ur.
  if (restoredFromPauseSleep) {
    if (tagPresent || phase != RESPITE) restoredFromPauseSleep = false;
    else if (now - restoredAtMs > 3000) {
      restoredFromPauseSleep = false;
      Serial.println("Ingen tagg efter uppvaknandet: telefonen lyftes ur");
      endSession(true);
      return;
    }
  }

  // Pausdvala: NFC-paus, stängt lock, pausmärket har synts en stund.
  if (phase == ACTIVE && sessionOwner == OWNER_TAG && lidClosed &&
      now - phaseStartMs > PAUSE_SLEEP_AFTER_MS && !uploadBusy && !lookupRequested) {
    hibernatePause();
  }

  // Skärmen väcks av all aktivitet efter att den släcktes.
  if (screenOff && (long)(lastActivityMs - screenOffSince) > 0) screenWake();

  if (!readyForSleep(now)) return;

  if (lidClosed) {
    if (idleFor < SLEEP_LID_CLOSED_MS) return;
    // Pauser som väntar på uppladdning: ge nätet en stund först. De ligger
    // kvar i minnet och skickas efter nästa uppvaknande annars.
    if (wifiQueueCount > 0 && idleFor < SLEEP_UPLOAD_GRACE_MS) return;
    // Locket stängdes medan servern inte hunnit svara om taggen: vänta.
    if (startWhenKnown && idleFor < SLEEP_OFFLINE_START_MS) return;
    goToDeepSleep();
  } else if (!screenOff && !tagPresent && !pairHold && idleFor > SCREEN_IDLE_MS) {
    screenSleep();
  }
}

void setup() {
  Serial.begin(115200);
  releaseSleepHolds();
  pinMode(POWER_PIN, OUTPUT);
  digitalWrite(POWER_PIN, HIGH);
  pinMode(LID_PIN, INPUT_PULLUP);

  tft.init();
  // Ur pausdvalan står drivaren kvar på det nedtonade steget (pinnen var hög
  // hela sömnen). Nollställ den och tänd fullt.
  blLevel = 1;
  setBacklightLevel(0);
  setBacklightLevel(BL_STEPS);
  tft.setRotation(1);
  initColors();
  tft.fillScreen(BG);

  // 320x170 i 16 bitar = 108 kB. I PSRAM om den finns — internminnet behövs
  // till Bluetooth, WiFi och TLS samtidigt.
  //
  // Utan PSRAM (Verktyg → PSRAM avstängt) tog bufferten 108 kB av
  // internminnet, och efter Bluetooth och WiFi var bara ~19 kB kvar: varje
  // HTTPS-anrop föll med -1 och skärmen stod på NO CONNECTION. Då ritas
  // skärmen i 8 bitar i stället (54 kB). Färgerna blir lite grövre, men
  // lådan kommer ut på nätet.
  bool hasPsram = psramFound();
  Serial.printf("PSRAM: %s (%u byte)\n", hasPsram ? "ja" : "NEJ", ESP.getPsramSize());
  if (!hasPsram) {
    Serial.println("Ingen PSRAM: skärmen ritas i 8 bitar. Slå på Verktyg -> PSRAM -> OPI PSRAM.");
  }
  sprite.setColorDepth(hasPsram ? 16 : 8);
  deepColor = hasPsram;
  sprite.setAttribute(PSRAM_ENABLE, hasPsram);
  spriteOK = (sprite.createSprite(SCREEN_W, SCREEN_H) != nullptr);
  if (!spriteOK) {
    Serial.println("KRITISKT: sprite kunde inte allokeras");
    tft.setTextColor(TFT_RED, BG);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("SPRITE ALLOC FAILED", CENTER_X, CENTER_Y, 2);
  }
  Serial.printf("Heap efter sprite: %u byte fri\n", ESP.getFreeHeap());

  loadPersisted();
  // Vaknade lådan ur pausdvalan fortsätter pausen, och checkpointen är
  // bara en reserv (endSession tar bort den). Annars: vanlig återställning.
  bool resumePause = false;
  if (sleepPause.magic == SLEEP_PAUSE_MAGIC) {
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_EXT0) resumePause = true;
    else sleepPause.magic = 0;
  }
  if (!resumePause) recoverCheckpoint();
  loadWifiSaved();
  // Inställningsnätet heter efter lådans chip, t.ex. PausePod-A7AC.
  snprintf(apName, sizeof(apName), "PausePod-%s",
           boxIdBle.length() >= 4 ? boxIdBle.substring(boxIdBle.length() - 4).c_str() : "0000");

  SPI.begin(RC522_SCK_PIN, RC522_MISO_PIN, RC522_MOSI_PIN, RC522_SS_PIN);
  startReader();

  netMutex = xSemaphoreCreateMutex();
  // 10 kB räcker för TLS (NFC-koden körde samma anrop i loopTasks 8 kB), och
  // stacken tas ur internminnet — samma minne som HTTPS-anropet behöver.
  xTaskCreatePinnedToCore(netTask, "net", 10240, nullptr, 1, nullptr, 0);

  BLEDevice::init("PausePod");
  BLEServer* pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());
  BLEService* pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_WRITE
  );
  pCharacteristic->setCallbacks(new CharCallbacks());
  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->start();

  lidClosed  = digitalRead(LID_PIN) == LOW;
  lastLidRaw = lidClosed;
  setPhase(IDLE);
  if (resumePause) restorePauseFromSleep();

  Serial.printf("Pause Pod v8 redo. låda=%s ble_id=%s seq=%lu wifi-kö=%d heap=%u största block=%u\n",
                BOX_ID, boxIdBle.c_str(), (unsigned long)nextSeq, wifiQueueCount,
                ESP.getFreeHeap(), ESP.getMaxAllocHeap());
}

void loop() {
  handlePortal();
  pollTag();
  handleLid();
  handleLookup();
  handleUploads();

  unsigned long now = millis();

  if (pendingAckSeq != 0) {
    uint32_t seq = pendingAckSeq;
    pendingAckSeq = 0;
    queueRemoveSeq(seq);
    if (backlogSending && seq == backlogAwaitSeq) {
      backlogSending = false;
      sendNextBacklog();
    }
  }

  // Paus vald i appen → be om telefonen
  if (pendingSetMode) {
    pendingSetMode = false;
    if (phase == IDLE) {
      startWhenKnown = false;
      phonePlaced = false;
      setPhase(AWAITING_LID);
    }
  }

  // Telefonen nedlagd enligt appen → be om locket
  if (pendingPhoneDown) {
    pendingPhoneDown = false;
    if (phase == IDLE || (phase == AWAITING_LID && !phonePlaced)) {
      phonePlaced = true;
      setPhase(AWAITING_LID);
    }
  }

  // Appens phone_up — gäller bara appens egna paus, som i v7. En NFC-paus
  // avslutas av taggen, inte av en telefon som kanske inte ens är ansluten.
  if (pendingPhoneUp) {
    pendingPhoneUp = false;
    if (phase == RESPITE && sessionOwner == OWNER_APP) {
      endSession(true);
    } else if (phase == AWAITING_LID && phonePlaced) {
      phonePlaced = false;
      setPhase(AWAITING_LID);
    }
  }

  if (phase == AWAITING_LID && !phonePlaced && now - phaseStartMs > PHONE_WAIT_MAX_MS) {
    phonePlaced = true;
    setPhase(AWAITING_LID);
  }

  if (phase == AWAITING_LID && phonePlaced && now - phaseStartMs > AWAIT_LID_MAX_MS) {
    setPhase(IDLE);
  }

  if (phase == CHECKED_IN && now - phaseStartMs > CER_END) {
    setPhase(ACTIVE);
    if (lidClosed) rfid.PCD_AntennaOff();
  }

  if (phase == ENDED && now - phaseStartMs > ENDED_SHOW_MS) {
    setPhase(IDLE);
  }

  // NFC-paus med öppet lock: ingen tagg sedan TAG_GONE_MS = telefonen lyft.
  // Fångar också fallet där ett läsglapp under stängt lock redan hade
  // markerat taggen som borta, så att onTagGone() aldrig kommer igen.
  if (phase == RESPITE && sessionOwner == OWNER_TAG && !tagPresent &&
      now - max(respiteStartMs, tagLastSeenMs) > TAG_GONE_MS) {
    endSession(true);
  }

  if (phase == RESPITE && now - respiteStartMs >= RESPITE_MS) {
    endSession(false);
  }

  if (sessionRunning() && now - lastCheckpointMs >= CHECKPOINT_MS) {
    checkpoint();
  }

  if (deviceConnected != lastDeviceConnected) {
    if (deviceConnected) {
      handshakeAt = now + HANDSHAKE_DELAY_MS;
    } else if (phase == AWAITING_LID && !phonePlaced) {
      phonePlaced = true;
      setPhase(AWAITING_LID);
    }
    lastDeviceConnected = deviceConnected;
  }

  if (handshakeAt != 0 && now >= handshakeAt) {
    handshakeAt = 0;
    onConnectedHandshake();
  }

  if (backlogStartAt != 0 && now >= backlogStartAt) {
    backlogStartAt = 0;
    if (!backlogSending) sendNextBacklog();
  }

  if (backlogSending && now - backlogSentAt > ACK_TIMEOUT_MS) {
    backlogSending = false;
    sendNextBacklog();
  }

  if (deviceConnected && now - lastBatteryReport > BATTERY_REPORT_MS) {
    sendBLE("battery:%d", batteryPercent());
    lastBatteryReport = now;
  }

  static unsigned long lastHeapLog = 0;
  if (now - lastHeapLog > HEAP_LOG_MS) {
    Serial.printf("batteri=%d%% (%.2f V) heap=%u största block=%u fas=%s wifi=%s wifi-kö=%d\n",
                  batteryPercent(), analogReadMilliVolts(BATTERY_ADC_PIN) * 2.0 / 1000.0,
                  ESP.getFreeHeap(), ESP.getMaxAllocHeap(), phaseName(phase),
                  wifiUp ? "uppe" : "nere", wifiQueueCount);
    lastHeapLog = now;
  }

  handleSleep();
  updateShownBattery();

  if (spriteOK && !screenOff && now - lastFrame >= FRAME_INTERVAL_MS) {
    switch (phase) {
      case IDLE:         renderIdle();        break;
      case CHECKED_IN:   renderCheckedIn();   break;
      case AWAITING_LID: renderAwaitingLid(); break;
      case ACTIVE:
        // Stillbild: rita en gång per fas, inte 30 gånger i sekunden.
        if (strcmp(lastDrawnQr, "active") != 0) {
          renderActive();
          strcpy(lastDrawnQr, "active");
        }
        break;
      case RESPITE:      renderRespite();     break;
      case ENDED:        renderEnded();       break;
      default:           renderActive();      break;   // STATS/CHECKING_IN/… nås inte längre
    }
    lastFrame = now;
  }

  delay(1);
}
