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
