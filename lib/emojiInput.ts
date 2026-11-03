// Ett emojifält ska hålla exakt ett tecken som användaren ser — inte två
// UTF-16-enheter. `maxLength={2}` på en TextInput räknar enheter, så ❤️, 👍🏽,
// 🏃‍♀️ och flaggor (3–11 enheter) vägrades helt och tangenttrycket gjorde
// ingenting. I stället tas sista hela grafemet: ett nytt emoji ersätter det
// gamla, och en inklistrad sträng ger sitt sista tecken.
//
// Hermes har inget pålitligt Intl.Segmenter på båda plattformarna, så
// klustren byggs för hand ur de regler emojis faktiskt använder.

const ZWJ = 0x200d;

/** Kodpunkter som alltid hänger på tecknet före. */
const isExtender = (cp: number) =>
  (cp >= 0xfe00 && cp <= 0xfe0f) ||   // variationsväljare (❤️)
  (cp >= 0x1f3fb && cp <= 0x1f3ff) || // hudtoner (👍🏽)
  cp === 0x20e3 ||                    // keycap (1️⃣)
  (cp >= 0xe0020 && cp <= 0xe007f) || // tag-tecken (subregionsflaggor)
  (cp >= 0x0300 && cp <= 0x036f);     // kombinerande diakriter

const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

function graphemes(text: string): string[] {
  const out: string[] = [];
  let joinNext = false;
  let riOpen = false; // en ensam regional indikator väntar på sin andra halva
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const last = out.length - 1;
    if (last >= 0 && (joinNext || isExtender(cp) || cp === ZWJ || (riOpen && isRegionalIndicator(cp)))) {
      out[last] += ch;
      if (isRegionalIndicator(cp)) riOpen = false;
    } else {
      out.push(ch);
      riOpen = isRegionalIndicator(cp);
    }
    joinNext = cp === ZWJ;
  }
  return out;
}

/** Sista synliga tecknet i texten, eller '' om den är tom. */
export function lastEmoji(text: string): string {
  const parts = graphemes(text.trim());
  return parts[parts.length - 1] ?? '';
}
