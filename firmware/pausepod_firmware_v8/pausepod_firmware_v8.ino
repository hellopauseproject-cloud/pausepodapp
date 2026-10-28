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
#include <TFT_eSPI.h>
#include <Preferences.h>
#include <SPI.h>
#include <MFRC522.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <stdarg.h>
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

#define HALL_PIN         1
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
extern char lastDrawnPairCode[11];

void setPhase(Phase p) {
  phase = p;
  phaseStartMs = millis();
  lastDrawnPairCode[0] = 0;   // QR-bilden ritas bara om vid byte — tvinga det här
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

void startReader() {
  rfid.PCD_Init();
  delay(50);
  rfid.PCD_SetAntennaGain(rfid.RxGain_max);   // kopior (0x88) läser bättre med full förstärkning
  rfid.PCD_DumpVersionToSerial();
}

bool readerOk() {
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  return v == 0x88 || v == 0x90 || v == 0x91 || v == 0x92 || v == 0x12 || v == 0xB2;
}

// Läser taggen om den ligger på läsaren, även om den lästs nyss (WakeupA
// väcker också en tagg som satts i HALT efter förra läsningen).
bool readTagOnce(char* out) {
  byte atqa[2];
  byte size = sizeof(atqa);
  if (rfid.PICC_WakeupA(atqa, &size) != MFRC522::STATUS_OK) return false;
  if (!rfid.PICC_ReadCardSerial()) return false;
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

bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) { wifiUp = true; return true; }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) delay(200);
  wifiUp = (WiFi.status() == WL_CONNECTED);
  if (wifiUp) Serial.println("WiFi OK: " + WiFi.localIP().toString());
  else        Serial.println("WiFi: kunde inte ansluta");
  return wifiUp;
}

// POST till en edge-funktion. Returnerar HTTP-koden (0 = inget svar).
int postToFunction(const char* fn, const String& body, String& response) {
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
  ensureWifi();
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

int batteryPercent() {
  int raw = analogRead(BATTERY_ADC_PIN);
  float v = (raw / 4095.0) * 2.0 * 3.3;
  int pct = (int)(((v - 3.30) / (4.20 - 3.30)) * 100.0);
  return constrain(pct, 0, 100);
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
  sprite.pushSprite(0, 0);
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
  sprite.pushSprite(0, 0);
}

// Känd tagg: hälsningen och vad som händer härnäst.
void renderHello() {
  sprite.fillSprite(BG);
  String hi = String("HI, ") + displayName();
  sprite.setTextDatum(MC_DATUM);
  fitHeadline(hi, SCREEN_W - 32);
  drawHeavy(hi, CENTER_X, 62, INK);
  drawInstructionPill("LID DOWN TO START", 118, HUE, LINE);
  sprite.pushSprite(0, 0);
}

void renderOffline() {
  sprite.fillSprite(BG);
  drawPauseMark(CENTER_X, 50, 30, LINE);
  sprite.setTextDatum(MC_DATUM);
  sprite.setFreeFont(&FreeSansBold18pt7b);
  drawHeavy("NO CONNECTION", CENTER_X, 98, INK);
  drawBody("Trying again.", CENTER_X, 134, INK_2);
  sprite.pushSprite(0, 0);
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

// Ny tagg: QR-koden till vänster, och koden att skriva in till höger.
void renderPairing() {
  sprite.fillSprite(BG);
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = drawQrToSprite;
  cfg.max_qrcode_version = 10;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;
  esp_qrcode_generate(&cfg, pairUrl[0] ? pairUrl : PAIR_URL_FALLBACK);

  const int x = QR_X + QR_AREA + 16;          // högerspaltens vänsterkant
  const int colW = SCREEN_W - x - 12;
  sprite.setTextDatum(TL_DATUM);
  drawKicker("NEW TAG", x, 16, HUE);

  sprite.setFreeFont(&FreeSansBold18pt7b);
  if (sprite.textWidth("SCAN TO") + 1 > colW) sprite.setFreeFont(&FreeSansBold12pt7b);
  drawHeavy("SCAN TO", x, 40, INK);
  drawHeavy("PAIR", x, 72, INK);

  drawBody("Or type the code:", x, 104, INK_2);

  // Koden i en pill, bokstäverna lite isär så att de går att läsa av.
  const int pillCy = 145, pillH = 32;
  drawPill(x + colW / 2, pillCy, colW, pillH, SURF, LINE);
  sprite.setFreeFont(&FreeSansBold12pt7b);
  const int track = 3;
  int len = strlen(pairCode);
  int total = 0;
  char ch[2] = {0, 0};
  for (int i = 0; i < len; i++) { ch[0] = pairCode[i]; total += sprite.textWidth(ch) + (i ? track : 0); }
  int cx = x + (colW - total) / 2;
  sprite.setTextDatum(ML_DATUM);
  sprite.setTextColor(INK);
  for (int i = 0; i < len; i++) {
    ch[0] = pairCode[i];
    sprite.drawString(ch, cx, pillCy);
    cx += sprite.textWidth(ch) + track;
  }
  sprite.pushSprite(0, 0);
}

// IDLE visar det taggen säger: inget, kollar, hej, QR eller ingen anslutning.
// QR-bilden ritas om bara när koden byts — den räknas inte fram 30 gånger i
// sekunden.
char lastDrawnPairCode[11] = "";

void renderIdle() {
  if (!tagPresent || tagInfo == TI_NONE) { lastDrawnPairCode[0] = 0; renderLogo(); return; }
  switch (tagInfo) {
    case TI_PENDING:
      lastDrawnPairCode[0] = 0;
      renderChecking();
      break;
    case TI_KNOWN:
      lastDrawnPairCode[0] = 0;
      renderHello();
      break;
    case TI_UNKNOWN:
      if (strcmp(lastDrawnPairCode, pairCode) != 0) {
        renderPairing();
        strncpy(lastDrawnPairCode, pairCode, sizeof(lastDrawnPairCode));
      }
      break;
    case TI_OFFLINE:
      lastDrawnPairCode[0] = 0;
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
  sprite.pushSprite(0, 0);
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
  sprite.pushSprite(0, 0);
}

void renderActive() {
  sprite.fillSprite(BG);
  drawActiveMark(1.0);
  sprite.pushSprite(0, 0);
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
  sprite.pushSprite(0, 0);
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
  sprite.pushSprite(0, 0);
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
  bool raw = digitalRead(HALL_PIN) == LOW;
  unsigned long now = millis();

  if (raw != lastLidRaw) { lastLidChangeMs = now; lastLidRaw = raw; }
  if (now - lastLidChangeMs < DEBOUNCE_MS) return;
  if (raw == lidClosed) return;

  lidClosed = raw;
  // Lock-händelser är appens bara när appen äger (eller kan komma att äga)
  // pausen. Under en NFC-paus, eller på loggan, säger de appen ingenting
  // den ska agera på.
  bool tellApp = (sessionOwner == OWNER_APP) || phase == AWAITING_LID;

  if (lidClosed) {
    if (tellApp) sendBLE("lid_closed");

    if (phase == RESPITE) {
      if (sessionOwner == OWNER_TAG && !tagPresent) {
        // Telefonen togs ur och locket stängdes över en tom låda.
        endSession(true);
      } else {
        sessionSegmentMs = millis();
        setPhase(ACTIVE);
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
      setPhase(RESPITE);
    }
  }
}

// ─── Taggen ─────────────────────────────────────────────────

void onTagArrived() {
  Serial.printf("Tagg: %s\n", tagUid);
  tagInfo = TI_PENDING;
  tagOwnerName[0] = 0;
  pairCode[0] = 0;
  requestLookup(tagUid);
}

void onTagGone() {
  Serial.println("Taggen borta");
  startWhenKnown = false;
  // Under en NFC-paus med öppet lock = telefonen lyftes ur → klar.
  if (phase == RESPITE && sessionOwner == OWNER_TAG) endSession(true);
  tagInfo = TI_NONE;
  tagOwnerName[0] = 0;
  pairCode[0] = 0;
}

void pollTag() {
  unsigned long now = millis();
  if (now - lastReaderCheckMs > READER_CHECK_MS) {
    lastReaderCheckMs = now;
    if (!readerOk()) {
      Serial.printf("Läsaren svarar inte rätt (0x%02X), startar om den\n",
                    rfid.PCD_ReadRegister(MFRC522::VersionReg));
      startReader();
      tagLastSeenMs = millis();   // omstarten tappar taggen en stund
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

void setup() {
  Serial.begin(115200);
  pinMode(POWER_PIN, OUTPUT);
  digitalWrite(POWER_PIN, HIGH);
  pinMode(HALL_PIN, INPUT_PULLUP);

  tft.init();
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
  recoverCheckpoint();

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

  lidClosed  = digitalRead(HALL_PIN) == LOW;
  lastLidRaw = lidClosed;
  setPhase(IDLE);

  Serial.printf("Pause Pod v8 redo. låda=%s ble_id=%s seq=%lu wifi-kö=%d heap=%u största block=%u\n",
                BOX_ID, boxIdBle.c_str(), (unsigned long)nextSeq, wifiQueueCount,
                ESP.getFreeHeap(), ESP.getMaxAllocHeap());
}

void loop() {
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
    Serial.printf("heap=%u största block=%u fas=%s wifi=%s wifi-kö=%d\n",
                  ESP.getFreeHeap(), ESP.getMaxAllocHeap(), phaseName(phase),
                  wifiUp ? "uppe" : "nere", wifiQueueCount);
    lastHeapLog = now;
  }

  if (spriteOK && now - lastFrame >= FRAME_INTERVAL_MS) {
    switch (phase) {
      case IDLE:         renderIdle();        break;
      case CHECKED_IN:   renderCheckedIn();   break;
      case AWAITING_LID: renderAwaitingLid(); break;
      case ACTIVE:       renderActive();      break;
      case RESPITE:      renderRespite();     break;
      case ENDED:        renderEnded();       break;
      default:           renderActive();      break;   // STATS/CHECKING_IN/… nås inte längre
    }
    lastFrame = now;
  }

  delay(1);
}
