import { useMemo, useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppPalette, Radius } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';

/**
 * Statistikens diagram — fyra tidsfönster, tre mått, ett anrop till datan.
 *
 * Ritas helt av vanliga View:ar, precis som ProgressRing och av samma skäl:
 * react-native-svg är en native-modul och hade krävt en ny dev-build. En stapel
 * är en View med en höjd — det räcker hela vägen, och det är därför DAY blev en
 * 24-timmarsrad i stället för en urtavla.
 *
 * Alla fyra fönstren är samma stapelrad, bara med olika antal fack och olika
 * skala under. Det var ett val: månaden ritades först som en kalender, men två
 * olika diagramformer i samma väljare gör att man läser om sidan varje gång man
 * byter flik i stället för att jämföra.
 *
 * Komponenten äger sitt eget tillstånd (fönster, mått, vilken period man
 * bläddrat till) och tar bara emot sessionerna. Alla sessioner skickas in, inte
 * en färdig delmängd: att byta månad ska vara ren datummatematik, inte ett nytt
 * nätverksanrop.
 *
 * **Intentionerna står under diagrammet, inte i det.** Upp till fem rader —
 * emoji, namn, ett tunt streck i diagrammets blå och talet — för perioden,
 * eller för den valda stapeln. Staplarna färgade efter intention prövades och
 * föll: för stökigt. Etiketten och emojin räknas ut av den som anropar
 * (`tag`) — diagrammet vet inget om kategorier.
 *
 * Veckan börjar på MÅNDAG i LOKAL tid här. Det är inte samma gräns som
 * circle_week_start() i supabase/circles.sql, som ligger på måndag 00:00 UTC —
 * och det är med flit: kretsens vecka måste vara delad för att potten ska
 * stämma för alla samtidigt, men det här är din egen logg, där "tisdag" ska
 * betyda den tisdag du faktiskt levde.
 */

export type ChartTag = { key: string; label: string; emoji: string };
export type ChartSession = {
  startedAt: string; durationSecs: number;
  /** Pausens intention, upplöst. `null` = otaggad. */
  tag?: ChartTag | null;
};

type Range = 'day' | 'week' | 'month' | 'year';
type Metric = 'count' | 'total' | 'avg';

type Tally = { count: number; secs: number };
type Bucket = Tally & { parts: Record<string, Tally> };

/** Otaggade pauser räknas i staplarna men står inte bland intentionerna. */
const UNTAGGED = '__untagged';
/** Så många intentioner som visas under diagrammet. */
const TAG_ROWS_MAX = 5;

/** En etikett på skalan och hur många fack den spänner över. */
type AxisSpan = { label: string; span: number };

const RANGES: { key: Range; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function fmtSecs(secs: number) {
  if (secs <= 0) return '—';
  if (secs < 60) return `${Math.round(secs)}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

// Måndagsindex: JS ger söndag = 0, vi vill ha måndag = 0.
function mondayIndex(d: Date) {
  return (d.getDay() + 6) % 7;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(d: Date) {
  const s = startOfDay(d);
  s.setDate(s.getDate() - mondayIndex(s));
  return s;
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

/** Periodens gränser: [från, till) i lokal tid. */
function periodBounds(range: Range, anchor: Date) {
  switch (range) {
    case 'day': {
      const from = startOfDay(anchor);
      const to = new Date(from); to.setDate(to.getDate() + 1);
      return { from, to };
    }
    case 'week': {
      const from = startOfWeek(anchor);
      const to = new Date(from); to.setDate(to.getDate() + 7);
      return { from, to };
    }
    case 'month': {
      const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
      return { from, to };
    }
    case 'year': {
      const from = new Date(anchor.getFullYear(), 0, 1);
      const to = new Date(anchor.getFullYear() + 1, 0, 1);
      return { from, to };
    }
  }
}

/** Flyttar ankaret ett helt fönster åt något håll. */
function shiftAnchor(range: Range, anchor: Date, dir: 1 | -1) {
  const d = new Date(anchor);
  if (range === 'day') d.setDate(d.getDate() + dir);
  else if (range === 'week') d.setDate(d.getDate() + dir * 7);
  else if (range === 'month') d.setMonth(d.getMonth() + dir);
  else d.setFullYear(d.getFullYear() + dir);
  return d;
}

function bucketCount(range: Range, anchor: Date) {
  if (range === 'day') return 24;
  if (range === 'week') return 7;
  if (range === 'month') return daysInMonth(anchor.getFullYear(), anchor.getMonth());
  return 12;
}

function bucketIndex(range: Range, d: Date) {
  if (range === 'day') return d.getHours();
  if (range === 'week') return mondayIndex(d);
  if (range === 'month') return d.getDate() - 1;
  return d.getMonth();
}

function metricValue(b: Tally, metric: Metric) {
  if (metric === 'count') return b.count;
  if (metric === 'total') return b.secs;
  return b.count > 0 ? b.secs / b.count : 0;
}

export function PauseActivityChart({ sessions }: { sessions: ChartSession[] }) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const [range, setRange] = useState<Range>('week');
  const [metric, setMetric] = useState<Metric>('count');
  const [anchor, setAnchor] = useState(() => new Date());
  const [selected, setSelected] = useState<number | null>(null);
  // Stapelhöjderna behöver ett tal, men ytan får sin höjd av flex — mät den.
  const [plotH, setPlotH] = useState(180);

  const { buckets, total, tags } = useMemo(() => {
    const { from, to } = periodBounds(range, anchor);
    const n = bucketCount(range, anchor);
    const out: Bucket[] = Array.from({ length: n }, () => ({ count: 0, secs: 0, parts: {} }));
    const sum: Bucket = { count: 0, secs: 0, parts: {} };
    const seen: Record<string, ChartTag> = {};
    const add = (b: Bucket, key: string, secs: number) => {
      b.count += 1;
      b.secs += secs;
      const t = (b.parts[key] ??= { count: 0, secs: 0 });
      t.count += 1;
      t.secs += secs;
    };

    for (const s of sessions) {
      if (!s.startedAt) continue;
      const d = new Date(s.startedAt);
      if (isNaN(d.getTime()) || d < from || d >= to) continue;
      const i = bucketIndex(range, d);
      if (i < 0 || i >= n) continue;
      const key = s.tag?.key ?? UNTAGGED;
      if (s.tag) seen[key] = s.tag;
      add(out[i], key, s.durationSecs);
      add(sum, key, s.durationSecs);
    }
    // Bara de taggade; otaggat säger inget om vad tiden blev.
    const tagged = Object.keys(sum.parts).filter(k => k !== UNTAGGED).map(k => seen[k]);
    return { buckets: out, total: sum, tags: tagged };
  }, [sessions, range, anchor]);

  const max = useMemo(
    () => buckets.reduce((m, b) => Math.max(m, metricValue(b, metric)), 0),
    [buckets, metric],
  );

  // Framåt är spärrat vid nuvarande period — det finns ingen data i framtiden,
  // och en tom graf som går att bläddra i för evigt ser ut som en bugg.
  const canGoForward = periodBounds(range, anchor).to <= new Date();

  const go = (dir: 1 | -1) => {
    if (dir === 1 && !canGoForward) return;
    setSelected(null);
    setAnchor(a => shiftAnchor(range, a, dir));
  };

  const pickRange = (key: Range) => {
    setSelected(null);
    setRange(key);
    setAnchor(new Date()); // byte av fönster landar alltid i nuet
  };

  const title = useMemo(() => {
    const now = new Date();
    if (range === 'day') {
      const a = startOfDay(anchor), t = startOfDay(now);
      const diff = Math.round((t.getTime() - a.getTime()) / 86400000);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Yesterday';
      return `${WEEKDAYS_LONG[mondayIndex(a)].slice(0, 3)} ${a.getDate()} ${MONTHS_SHORT[a.getMonth()]}`;
    }
    if (range === 'week') {
      const from = startOfWeek(anchor);
      const end = new Date(from); end.setDate(end.getDate() + 6);
      if (from.getTime() === startOfWeek(now).getTime()) return 'This week';
      const left = `${from.getDate()} ${MONTHS_SHORT[from.getMonth()]}`;
      const right = `${end.getDate()} ${MONTHS_SHORT[end.getMonth()]}`;
      return `${left} – ${right}`;
    }
    if (range === 'month') {
      const m = MONTHS_LONG[anchor.getMonth()];
      return anchor.getFullYear() === now.getFullYear() ? m : `${m} ${anchor.getFullYear()}`;
    }
    return String(anchor.getFullYear());
  }, [range, anchor]);

  const readout = useMemo(() => {
    if (selected === null) return null;
    const b = buckets[selected];
    if (!b) return null;
    let label: string;
    if (range === 'day') label = `${String(selected).padStart(2, '0')}:00`;
    else if (range === 'week') label = WEEKDAYS_LONG[selected];
    else if (range === 'month') label = `${selected + 1} ${MONTHS_SHORT[anchor.getMonth()]}`;
    else label = MONTHS_LONG[selected];

    if (b.count === 0) return `${label} · no pauses`;
    const noun = b.count === 1 ? 'pause' : 'pauses';
    return `${label} · ${b.count} ${noun} · ${fmtSecs(b.secs)}`;
  }, [selected, buckets, range, anchor]);

  // Intentionerna: den valda stapelns, annars periodens, största först efter
  // måttet. Strecken mäts mot den största raden.
  const tagSource = (selected !== null ? buckets[selected] : null) ?? total;
  const tagRows = tags
    .filter(t => tagSource.parts[t.key])
    .map(t => {
      const p = tagSource.parts[t.key];
      const v = metricValue(p, metric);
      return { ...t, v, value: metric === 'count' ? String(p.count) : fmtSecs(v) };
    })
    .sort((a, b) => b.v - a.v)
    .slice(0, TAG_ROWS_MAX);
  const tagMax = tagRows[0]?.v ?? 0;

  const tap = (i: number) => setSelected(prev => (prev === i ? null : i));

  // Dag och månad har 24 respektive upp till 31 staplar. Ett fack blir då runt
  // tio punkter brett, vilket inte rymmer "18" eller "15" — så de täta
  // fönstren får en linjalskala i stället: varje etikett spänner över sitt
  // intervall och sitter i dess vänsterkant, rakt ovanför stapeln den gäller.
  // Vecka och år har gott om plats och behåller en etikett per stapel.
  const dense = range === 'day' || range === 'month';

  const axis = useMemo<AxisSpan[]>(() => {
    if (range === 'day') {
      return ['00', '06', '12', '18'].map(label => ({ label, span: 6 }));
    }
    if (range === 'month') {
      const n = buckets.length;
      const out: AxisSpan[] = [];
      for (let d = 1; d <= n; d += 7) out.push({ label: String(d), span: Math.min(7, n - d + 1) });
      return out;
    }
    const labels = range === 'week' ? WEEKDAYS_SHORT : MONTHS_SHORT.map(m => m[0]);
    return labels.map(label => ({ label, span: 1 }));
  }, [range, buckets.length]);

  // Kalendern pekade ut dagens datum; staplarna får samma hjälp av en prick
  // under rätt fack. Utan den är det svårt att se var i månaden man står när
  // de sista dagarna ännu är tomma.
  const markIndex = useMemo(() => {
    const now = new Date();
    const { from, to } = periodBounds(range, anchor);
    if (now < from || now >= to) return null;
    return bucketIndex(range, now);
  }, [range, anchor]);

  const metrics: { key: Metric; value: string; label: string }[] = [
    { key: 'count', value: String(total.count), label: 'pauses' },
    { key: 'total', value: fmtSecs(total.secs), label: 'total time' },
    { key: 'avg', value: fmtSecs(total.count > 0 ? total.secs / total.count : 0), label: 'average' },
  ];

  return (
    <View style={styles.wrap}>
      {/* Fönstret */}
      <View style={styles.segmented}>
        {RANGES.map(r => {
          const on = r.key === range;
          return (
            <Pressable
              key={r.key}
              onPress={() => pickRange(r.key)}
              style={[styles.segment, on && styles.segmentOn]}
            >
              <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{r.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Perioden */}
      <View style={styles.periodRow}>
        <Pressable onPress={() => go(-1)} hitSlop={12} style={styles.arrow}>
          <Text style={styles.arrowText}>‹</Text>
        </Pressable>
        <Text style={styles.periodTitle} numberOfLines={1}>{title.toUpperCase()}</Text>
        <Pressable onPress={() => go(1)} hitSlop={12} style={styles.arrow} disabled={!canGoForward}>
          <Text style={[styles.arrowText, !canGoForward && styles.arrowOff]}>›</Text>
        </Pressable>
      </View>

      {/* Måtten — samtidigt sammanfattning och väljare för vad staplarna visar */}
      <View style={styles.metricRow}>
        {metrics.map((m, i) => {
          const on = m.key === metric;
          return (
            <Pressable
              key={m.key}
              onPress={() => setMetric(m.key)}
              style={[styles.metric, on && styles.metricOn, i > 0 && styles.metricGap]}
            >
              <Text style={[styles.metricValue, on && styles.metricValueOn]}>{m.value}</Text>
              <Text style={[styles.metricLabel, on && styles.metricLabelOn]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* Grafen */}
      <View style={styles.plotArea}>
        <Bars
          buckets={buckets}
          metric={metric}
          max={max}
          selected={selected}
          onPick={tap}
          onLayout={(e: LayoutChangeEvent) => setPlotH(e.nativeEvent.layout.height)}
          height={plotH}
          axis={axis}
          axisAlign={dense ? 'left' : 'center'}
          slim={dense}
          markIndex={markIndex}
        />

        {/* Tomt fönster: skalan får stå kvar under texten, så att det syns att
            det är perioden som är tom och inte diagrammet som gått sönder. */}
        {total.count === 0 && (
          <View pointerEvents="none" style={styles.emptyOverlay}>
            <Text style={styles.emptyText}>No pauses here</Text>
          </View>
        )}
      </View>

      {/* Alltid renderad, osynlig när inget är valt: annars hoppar grafen i
          höjd varje gång man trycker på en stapel. */}
      <Text style={[styles.readout, !readout && styles.readoutHidden]} numberOfLines={1}>
        {readout ?? 'placeholder'}
      </Text>

      {tagRows.length > 0 && (
        <View style={styles.tags}>
          {tagRows.map(t => (
            <View key={t.key} style={styles.tagRow}>
              <Text style={styles.tagEmoji}>{t.emoji}</Text>
              <Text style={styles.tagLabel} numberOfLines={1}>{t.label}</Text>
              <View style={styles.tagTrack}>
                <View style={[styles.tagFill, { width: `${Math.max(4, (t.v / tagMax) * 100)}%` }]} />
              </View>
              <Text style={styles.tagValue}>{t.value}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function Bars({
  buckets, metric, max, selected, onPick, onLayout, height, axis, axisAlign, slim, markIndex,
}: {
  buckets: Bucket[]; metric: Metric; max: number; selected: number | null;
  onPick: (i: number) => void; onLayout: (e: LayoutChangeEvent) => void;
  height: number; axis: AxisSpan[]; axisAlign: 'left' | 'center';
  slim: boolean; markIndex: number | null;
}) {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  return (
    <View style={styles.barsWrap}>
      <View style={styles.plot} onLayout={onLayout}>
        {buckets.map((b, i) => {
          const v = metricValue(b, metric);
          const on = selected === i;
          // Tomma timmar får en hårfin sockel i stället för ingenting alls:
          // raden ska läsas som en tidslinje även där det inte hänt något.
          const h = v > 0 && max > 0 ? Math.max(4, (v / max) * (height - 6)) : 3;
          return (
            <Pressable key={i} onPress={() => onPick(i)} style={styles.barSlot}>
              <View
                style={[
                  styles.bar,
                  !slim && styles.barWide,
                  { height: h },
                  v === 0 && styles.barEmpty,
                  on && styles.barOn,
                ]}
              />
            </Pressable>
          );
        })}
      </View>
      {/* Dagens markör ligger i en egen rad med samma fackgeometri som
          staplarna, i stället för inuti facket: en prick under stapeln hade
          tryckt upp den och gjort just den stapeln kortare än sitt värde. */}
      {markIndex !== null && (
        <View style={styles.markRow} pointerEvents="none">
          {buckets.map((_, i) => (
            <View key={i} style={styles.markSlot}>
              {i === markIndex && <View style={styles.mark} />}
            </View>
          ))}
        </View>
      )}

      <View style={styles.axis}>
        {axis.map((a, i) => (
          <View
            key={i}
            style={[{ flex: a.span }, axisAlign === 'center' ? styles.axisCenter : styles.axisLeft]}
          >
            <Text
              style={[
                styles.axisText,
                // Bara den täta skalans etiketter är en per stapel; i
                // linjalläget svarar index inte mot ett enskilt fack.
                axisAlign === 'center' && selected === i && styles.axisTextOn,
              ]}
            >
              {a.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  wrap: { flex: 1 },

  // Fönsterväljaren
  segmented: {
    flexDirection: 'row',
    backgroundColor: Palette.surface,
    borderRadius: Radius.pill,
    borderWidth: 1, borderColor: Palette.surfaceBorder,
    padding: 4,
  },
  segment: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 9, borderRadius: Radius.pill,
  },
  segmentOn: { backgroundColor: Palette.accentTint },
  segmentText: {
    fontSize: 12, fontWeight: '900', letterSpacing: 1.4,
    textTransform: 'uppercase', color: Palette.textTertiary,
  },
  segmentTextOn: { color: Palette.textPrimary },

  // Perioden
  periodRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 22, marginBottom: 18, paddingHorizontal: 4,
  },
  arrow: { width: 40, height: 34, alignItems: 'center', justifyContent: 'center' },
  arrowText: { fontSize: 26, lineHeight: 30, color: Palette.accent, fontWeight: '700' },
  arrowOff: { color: Palette.ink12 },
  periodTitle: {
    flex: 1, textAlign: 'center',
    fontSize: 14, fontWeight: '900', letterSpacing: 2.4, color: Palette.textPrimary,
  },

  // Måtten
  metricRow: { flexDirection: 'row' },
  metric: {
    flex: 1, alignItems: 'center', gap: 5,
    paddingVertical: 14, paddingHorizontal: 4,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: 'transparent',
    backgroundColor: Palette.surface,
  },
  metricGap: { marginLeft: 8 },
  metricOn: { backgroundColor: Palette.accentTint, borderColor: Palette.accentBorder },
  metricValue: {
    fontSize: 22, fontWeight: '900', letterSpacing: -0.6,
    color: Palette.ink60,
  },
  metricValueOn: { color: Palette.textPrimary },
  metricLabel: {
    fontSize: 11, letterSpacing: 1.4, textTransform: 'uppercase',
    color: Palette.ink50,
  },
  // Lyft med sitt syskon ovan, annars blir av och på samma ton.
  metricLabelOn: { color: Palette.ink80 },

  // Grafytan
  plotArea: { flex: 1, minHeight: 190, justifyContent: 'center', marginTop: 24 },

  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyText: {
    fontSize: 12, fontWeight: '900', letterSpacing: 2.2,
    textTransform: 'uppercase', color: Palette.ink50,
  },

  barsWrap: { flex: 1, justifyContent: 'flex-end' },
  plot: { flex: 1, minHeight: 140, flexDirection: 'row', alignItems: 'flex-end' },
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 1.5 },
  bar: {
    width: '100%', maxWidth: 16,
    borderRadius: 4,
    backgroundColor: Palette.accent,
  },
  barWide: { maxWidth: 30 },
  barEmpty: { backgroundColor: Palette.ink07 },
  barOn: { backgroundColor: Palette.accentSoft },

  markRow: { flexDirection: 'row', height: 7, marginTop: 4 },
  markSlot: { flex: 1, alignItems: 'center', paddingHorizontal: 1.5 },
  mark: { width: 3, height: 3, borderRadius: 2, backgroundColor: Palette.ink45 },

  axis: { flexDirection: 'row', marginTop: 6 },
  axisCenter: { alignItems: 'center', paddingHorizontal: 1.5 },
  axisLeft: { alignItems: 'flex-start' },
  // M T W T F S S. ink28 gav 2.38:1 — nu 5.79:1.
  axisText: { fontSize: 11, letterSpacing: 0.6, color: Palette.ink55, fontWeight: '700' },
  axisTextOn: { color: Palette.accentSoft },

  // Avläsningen
  readout: {
    marginTop: 16, textAlign: 'center',
    fontSize: 13, letterSpacing: 0.6, color: Palette.accentSoft, fontWeight: '600',
  },
  readoutHidden: { opacity: 0 },

  // Intentionerna: en rad var, i diagrammets blå och utan egna kulörer.
  tags: { marginTop: 18, gap: 10 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tagEmoji: { fontSize: 16, width: 22, textAlign: 'center' },
  tagLabel: { width: 88, fontSize: 13, color: Palette.textSecondary },
  tagTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: Palette.ink07, overflow: 'hidden' },
  tagFill: { height: '100%', borderRadius: 3, backgroundColor: Palette.accent },
  tagValue: { minWidth: 52, textAlign: 'right', fontSize: 13, fontWeight: '800', color: Palette.textPrimary },
});
