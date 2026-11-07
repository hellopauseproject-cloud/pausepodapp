#pragma once

#include <Arduino.h>

enum Phase {
  IDLE,
  STATS,
  CHECKING_IN,
  CHECKED_IN,
  AWAITING_LID,
  ACTIVE,
  SHOWING_TIME,
  CHECKOUT_ARMING,
  CHECKOUT_CONFIRM,
  RESPITE,
  ENDED
};

struct TouchPad {
  int           pin;
  bool          state;
  bool          lastRaw;
  unsigned long pressedAtMs;
  unsigned long lastChangeMs;
  const char*   name;
};

struct SessionRecord {
  uint32_t      seq;
  uint32_t      durationMs;
  unsigned long endedAtMillis;
  uint8_t       completed;
};

// En färg som tre byte, för toningar på skärmen. Bor här och inte i .ino:
// Arduino lägger funktionsdeklarationerna överst i sketchen, före en struct
// som definierats längre ner.
struct Rgb { uint8_t r, g, b; };

// En rad i sömnloggen (se "Sömnloggen" i .ino). Här av samma skäl som Rgb.
struct DiagEntry {
  uint32_t boot;     // startnummer, räknas upp vid varje start
  uint32_t rtcS;     // RTC-klockan i sekunder (går genom djupsömn, nollas utan ström)
  uint32_t awakeMs;  // vid sömn: hur länge lådan var vaken sedan starten
  uint16_t mv;       // batteriets spänning i mV
  uint8_t  kind;     // 0 = start, 1 = djupsömn, 2 = pausdvala
  uint8_t  reason;   // vid start: esp_reset_reason()
  uint8_t  wake;     // vid start: esp_sleep_get_wakeup_cause()
  uint8_t  lid;      // locket stängt (1) eller öppet (0) just då
};
