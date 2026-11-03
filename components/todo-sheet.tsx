import { FontAwesome, FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Keyboard, LayoutChangeEvent, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import Animated, {
  cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue,
  withDelay, withSequence, withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppPalette, Radius, Spacing } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { track } from '../lib/analytics';
import { useHand } from '../lib/handFont';
import {
  addTodo, completeTodo, deleteTodo, doneAgo, getTodos, reopenTodo, setTodoHidden, sortDone, Todo,
} from '../lib/todos';

/**
 * Att göra-listan: lappen som sticker upp i Hems nedre vänstra hörn, arket
 * bakom den, och kretsens lappar i kretsfliken.
 *
 * Lappen på Hem ersätter lakanet som låg längst ner och revs för att det tog
 * för mycket plats. Den är medvetet ett **hörn**: den ska säga att listan
 * finns utan att slåss med ringen och PAUSE om höjden, och den ligger under
 * PAUSE-knappens golv (`MIN_BOTTOM_GAP` + containerns `BOTTOM_PAD` i
 * app/(tabs)/index.tsx = 56) så att heronens räkning inte behöver veta om den.
 *
 * **Bara kretsen ser listan.** Vänner gör det inte: vänlistan har ingen övre
 * gräns, och vänner ser inte ens pausaktivitet utan `show_stats`. Den som
 * vill visa en enskild punkt för vänner gör det genom *Ask for support*, som
 * gör punkten till en story i 24 timmar.
 */

// ── Pappret ───────────────────────────────────────────────────────────────
// Inte palettstyrt, av samma skäl som regnbågen på nivåmärket: en post-it är
// ett föremål med sin egen kulör, och `highlight` är senapsbrun i ljust läge
// (#8f6708) — ett papper i den tonen läser som en fläck, inte en lapp.
// Pappret är gult. En kort stund var det ljus pastell-lila för att läsa som
// en del av plommonbottnen, men gult togs tillbaka på begäran — en post-it
// ska se ut som en post-it. Mörkt läge får en dämpad gul så att lappen inte
// bländar mot plommon. Bläcket klarar 4.5:1 mot pappret i båda (`inkSoft`
// 5.1:1).
// Ett varmt, nästan vitt papper: designsystemets Cream ljusad mot vitt, med
// Navy-bläck. Neutralt nog att stå i både Pause-rummets blå och Kretsens
// gröna. Gult drog blicken och fanns ingen annanstans; Ice (blåvitt) krockade
// med det gröna i ljust läge. I mörkt läge något dämpat, så att lappen inte
// lyser mot navy.
const PAPER = {
  dark: { paper: '#e7dfd0', fold: '#cdc3b0', ink: '#0a1330', inkSoft: 'rgba(10,19,48,0.7)', tape: 'rgba(255,252,245,0.45)' },
  light: { paper: '#fbf6ec', fold: '#e8dfcd', ink: '#0a1330', inkSoft: 'rgba(10,19,48,0.7)', tape: 'rgba(255,255,255,0.6)' },
};
type Paper = typeof PAPER.dark;
const usePaper = (): Paper => PAPER[usePalette().mode === 'dark' ? 'dark' : 'light'];


// Hur mycket av lappen på Hem som syns. Resten är klippt, så att den ser
// instoppad ut bakom flikraden. Måste ligga under 56 (se ovan). Höjdes från 46
// när lappen fick visa två punkter: båda raderna ska synas hela, för det var
// den halva raden som fick lappen att se avklippt ut.
const PEEK_H = 54;
// Guppet: lappen lyfts så här mycket varje gång Hem får fokus, och sjunker
// tillbaka. Utan det läste hörnet som avklippt i stället för instoppat —
// rapporterat som "man ser bara hälften". Klippet är så här mycket högre än
// PEEK_H, med samma tal i paddingTop, så att lappen vilar på samma ställe och
// har plats att stiga. Höjden är bara tillfällig, så heronens räkning
// behöver fortfarande inte veta om den.
const BOB = 18;
const BOB_DELAY_MS = 650;
const NOTE_W = 132;
const NOTE_H = 80;
const TILT_DEG = -4;
const MAX_LEN = 140;
// Punkter på lappen. Två ryms under golvet; fler står som `+N`.
const POST_IT_ITEMS = 2;

/** Lappens ruta i fönstret, så att arket kan växa fram ur den. */
export type NoteRect = { x: number; y: number; width: number; height: number };

// ── Lappen på Hem ─────────────────────────────────────────────────────────

export function TodoPostIt({ todos, onPress, lifted = false }: {
  todos: Todo[];
  onPress: (from: NoteRect | null) => void;
  /** Arket står uppe: lappen är "lyft" och syns inte på sin plats. */
  lifted?: boolean;
}) {
  const Palette = usePalette();
  const paper = usePaper();
  const hand = useHand();
  const open = todos.filter(t => !t.done_at);
  const shown = open.slice(0, POST_IT_ITEMS);
  const more = open.length - shown.length;
  const noteRef = useRef<View>(null);

  // Guppar vid varje fokus (flikar avmonteras inte, så montering räcker inte).
  // Väntar tills Hems övertoning hunnit in. Inget gupp med reducerad rörelse.
  const reduceMotion = useReducedMotion();
  const lift = useSharedValue(0);
  useFocusEffect(useCallback(() => {
    if (reduceMotion) return;
    lift.value = withDelay(BOB_DELAY_MS, withSequence(
      withTiming(-BOB, { duration: 320, easing: Easing.out(Easing.cubic) }),
      withDelay(380, withTiming(0, { duration: 520, easing: Easing.inOut(Easing.cubic) })),
    ));
    return () => { cancelAnimation(lift); lift.value = 0; };
  }, [reduceMotion, lift]));
  const liftStyle = useAnimatedStyle(() => ({ transform: [{ translateY: lift.value }] }));

  // Lappens ruta mäts vid trycket och inte vid layout: guppet flyttar den.
  const handlePress = () => {
    const node = noteRef.current;
    if (!node) { onPress(null); return; }
    node.measureInWindow((x, y, width, height) => onPress(width ? { x, y, width, height } : null));
  };

  return (
    <View style={[postIt.clip, lifted && postIt.lifted]} pointerEvents="box-none">
      <Animated.View style={liftStyle}>
      <View ref={noteRef} collapsable={false}>
      <TouchableOpacity
        onPress={handlePress}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={open.length
          ? `To do, ${open.length} ${open.length === 1 ? 'thing' : 'things'}. Opens your list.`
          : 'To do. Opens your list.'}
        style={[postIt.note, { backgroundColor: paper.paper }]}
      >
        {/* Hundöra uppe till höger — det är det som gör en gul rektangel
            till en lapp. */}
        <View style={[postIt.fold, { borderTopColor: Palette.bg, borderLeftColor: paper.fold }]} />
        {shown.length === 0 ? (
          <>
            <Text style={[postIt.label, { color: paper.inkSoft }]}>TO DO</Text>
            <Text style={[postIt.empty, hand(14), { color: paper.ink }]}>+ Add</Text>
          </>
        ) : (
          // Rutorna säger "att göra" utan etiketten, som fick ge plats åt den
          // andra punkten.
          shown.map((t, i) => (
            <View key={t.id} style={postIt.item}>
              <View style={[postIt.box, { borderColor: paper.inkSoft }]} />
              <Text style={[postIt.text, hand(14), { color: paper.ink }]} numberOfLines={1}>{t.text}</Text>
              {i === shown.length - 1 && more > 0 && (
                <Text style={[postIt.more, { color: paper.inkSoft }]}>+{more}</Text>
              )}
            </View>
          ))
        )}
      </TouchableOpacity>
      </View>
      </Animated.View>
    </View>
  );
}

const postIt = StyleSheet.create({
  clip: {
    position: 'absolute', left: Spacing.lg, bottom: 0,
    width: NOTE_W + 24, height: PEEK_H + BOB,
    overflow: 'hidden',
    // Plats ovanför lappen för vridningens hörn, och för guppet.
    paddingTop: 6 + BOB, paddingLeft: 8,
  },
  lifted: { opacity: 0 },
  note: {
    width: NOTE_W, height: NOTE_H,
    borderTopLeftRadius: 3, borderTopRightRadius: 3,
    paddingLeft: 11, paddingRight: 14, paddingTop: 8,
    transform: [{ rotate: `${TILT_DEG}deg` }],
    shadowColor: '#000', shadowOffset: { width: 0, height: -1 },
    shadowOpacity: 0.18, shadowRadius: 4, elevation: 3,
  },
  fold: {
    position: 'absolute', top: 0, right: 0,
    width: 0, height: 0,
    borderTopWidth: 12, borderLeftWidth: 12,
    borderRightColor: 'transparent', borderBottomColor: 'transparent',
  },
  label: { fontSize: 11, lineHeight: 14, fontWeight: '900', letterSpacing: 1.2 },
  empty: { fontSize: 14, lineHeight: 20, marginTop: 1 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 19 },
  box: { width: 9, height: 9, borderRadius: 2, borderWidth: 1.3 },
  text: { flex: 1, fontSize: 14, lineHeight: 19 },
  more: { fontSize: 11, lineHeight: 14, fontWeight: '900' },
});

// ── Kretsens lappar ───────────────────────────────────────────────────────
// En lapp per medlem, i samma ordning som ringens brickor (man själv först,
// sedan kretsens egen ordning — aldrig sorterat efter hur mycket någon gjort).
// Väljs någon i ringen kommer hens lapp fram och de andra tonas bak, precis
// som brickorna.

const CN_W = 150;
const CN_H = 168;
const CN_GAP = 14;
const CN_PREVIEW = 4;
// Fasta vridningar och inte slumpade, så att lapparna ligger likadant varje
// gång fliken öppnas — samma skäl som bubblorna i liquid-bars.
const CN_TILTS = ['-2.4deg', '1.8deg', '-1.2deg', '2.2deg', '-1.8deg', '1.2deg', '-2deg', '1.6deg'];

export type NoteMember = { id: string; username: string };

export function CircleTodoNotes({
  members, todos, meId, selectedId, onOpenMine,
}: {
  members: NoteMember[];
  /** Alla synliga punkter; de sorteras på medlem här. */
  todos: Todo[];
  meId: string;
  /** Den medlem som är vald i ringen, eller null. */
  selectedId: string | null;
  onOpenMine: () => void;
}) {
  const Palette = usePalette();
  const paper = usePaper();
  const hand = useHand();
  const styles = useMemo(() => makeStyles(Palette, paper), [Palette, paper]);
  const [viewing, setViewing] = useState<NoteMember | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const ordered = useMemo(() => [
    ...members.filter(m => m.id === meId),
    ...members.filter(m => m.id !== meId),
  ], [members, meId]);

  const byUser = useMemo(() => {
    const map = new Map<string, { open: Todo[]; done: Todo[] }>();
    for (const m of members) map.set(m.id, { open: [], done: [] });
    for (const t of todos) {
      // Ens egna dolda punkter kommer med i svaret (policyn släpper alltid
      // igenom egna rader), men den här raden visar vad kretsen ser.
      if (t.hidden_from_circle) continue;
      const e = map.get(t.user_id);
      if (e) (t.done_at ? e.done : e.open).push(t);
    }
    for (const e of map.values()) e.done = sortDone(e.done);
    return map;
  }, [members, todos]);

  // Den valda lappen rullas in i bild — annars händer det ingenting synligt
  // här när man trycker på en bricka längre ner i raden.
  useEffect(() => {
    if (!selectedId) return;
    const i = ordered.findIndex(m => m.id === selectedId);
    if (i >= 0) scrollRef.current?.scrollTo({ x: i * (CN_W + CN_GAP), animated: true });
  }, [selectedId, ordered]);

  const viewingList = viewing ? byUser.get(viewing.id) : undefined;

  return (
    <>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.notesRow}
      >
        {ordered.map((m, i) => {
          const isMe = m.id === meId;
          const list = byUser.get(m.id) ?? { open: [], done: [] };
          const items = [...list.open, ...list.done];
          const shown = items.slice(0, CN_PREVIEW);
          const more = items.length - shown.length;
          const dimmed = !!selectedId && selectedId !== m.id;
          return (
            <TouchableOpacity
              key={m.id}
              activeOpacity={0.85}
              onPress={() => {
                if (isMe) onOpenMine();
                else { setViewing(m); track('circle_todos_opened'); }
              }}
              accessibilityRole="button"
              accessibilityLabel={`${isMe ? 'Your' : `${m.username}'s`} to-do list. ${list.open.length} open, ${list.done.length} ticked off this week.`}
              style={[
                styles.note,
                { backgroundColor: paper.paper, transform: [{ rotate: CN_TILTS[i % CN_TILTS.length] }] },
                dimmed && styles.noteDimmed,
              ]}
            >
              {/* Tejpen. Den är det som gör en rad gula rutor till lappar
                  som sitter uppe, och inte kort i en lista. */}
              <View style={[styles.tape, { backgroundColor: paper.tape }]} />
              <Text style={[styles.noteName, { color: paper.inkSoft }]} numberOfLines={1}>
                {isMe ? 'YOU' : m.username.toUpperCase()}
              </Text>
              {shown.length === 0 ? (
                <Text style={[styles.noteEmpty, hand(13), { color: paper.inkSoft }]}>
                  {isMe ? '+ Add something' : 'Nothing yet.'}
                </Text>
              ) : (
                shown.map(t => (
                  <View key={t.id} style={styles.noteItem}>
                    <View style={[styles.noteBox, { borderColor: paper.ink }, !!t.done_at && { backgroundColor: paper.ink }]}>
                      {!!t.done_at && <FontAwesome5 name="check" size={7} color={paper.paper} />}
                    </View>
                    <Text
                      style={[styles.noteText, hand(13), { color: t.done_at ? paper.inkSoft : paper.ink }, !!t.done_at && styles.strike]}
                      numberOfLines={2}
                    >
                      {t.text}
                    </Text>
                  </View>
                ))
              )}
              {more > 0 && <Text style={[styles.noteMore, { color: paper.inkSoft }]}>+{more} more</Text>}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* En annans lista, i sin helhet. Bara läsning: ingen bockar av åt
          någon annan. */}
      <Modal visible={!!viewing} transparent animationType="slide" onRequestClose={() => setViewing(null)}>
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewing(null)} accessibilityLabel="Close" />
          <SheetBody title={viewing ? `${viewing.username} · to do` : ''}>
            <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
              <Ruled>
                {viewingList && viewingList.open.length + viewingList.done.length > 0 ? (
                  <ReadOnlyItems open={viewingList.open} done={viewingList.done} />
                ) : (
                  <Text style={[styles.empty, hand(14)]}>Nothing on the list yet.</Text>
                )}
              </Ruled>
            </ScrollView>
          </SheetBody>
        </View>
      </Modal>
    </>
  );
}

function ReadOnlyItems({ open, done }: { open: Todo[]; done: Todo[] }) {
  const Palette = usePalette();
  const paper = usePaper();
  const styles = useMemo(() => makeStyles(Palette, paper), [Palette, paper]);
  const hand = useHand();
  return (
    <>
      {open.map(t => (
        <View key={t.id} style={styles.roRow} accessible accessibilityLabel={`To do: ${t.text}`}>
          <Check done={false} />
          <Text style={[styles.rowText, hand(16)]}>{t.text}</Text>
        </View>
      ))}
      {done.length > 0 && <GroupLabel />}
      {done.map(t => (
        <View
          key={t.id}
          style={styles.roRow}
          accessible
          accessibilityLabel={`Ticked off ${t.done_at ? doneAgo(t.done_at) : ''}: ${t.text}`}
        >
          <Check done />
          <Text style={[styles.rowText, hand(16), styles.rowTextDone]}>{t.text}</Text>
        </View>
      ))}
    </>
  );
}

// ── Linjerat papper ───────────────────────────────────────────────────────
// Listan står på ett linjerat block: blå linjer och en röd marginal, som ett
// gult anteckningsblock. Varje rad är exakt `LINE` hög (en punkt som bryter
// blir två `LINE`), och linjerna ritas bakom med samma steg — så texten
// står på linjerna och inte mellan dem. En rad som inte är en `LINE`-multipel
// förskjuter allt under sig från linjerna; därför har grupprubriken en tom
// rad ovanför sig i stället för en marginal.
const LINE = 36;
const MIN_LINES = 4;
// Var marginalen går: mellan bocken (22) och texten (gap 12).
const MARGIN_X = 28;
// Texten sjunker så här mycket mot sin linje — en hand skriver på linjen, och
// mitt i radhöjden svävar den.
const TEXT_DROP = 5;

function Ruled({ children }: { children: ReactNode }) {
  const Palette = usePalette();
  const paper = usePaper();
  const styles = useMemo(() => makeStyles(Palette, paper), [Palette, paper]);
  const [h, setH] = useState(0);
  const lines = Math.max(MIN_LINES, Math.floor(h / LINE));
  return (
    <View style={styles.ruled} onLayout={e => setH(e.nativeEvent.layout.height)}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {Array.from({ length: lines }, (_, i) => (
          <View key={i} style={[styles.rule, { top: (i + 1) * LINE - 1 }]} />
        ))}
        <View style={styles.margin} />
      </View>
      {children}
    </View>
  );
}

function GroupLabel() {
  const Palette = usePalette();
  const paper = usePaper();
  const styles = useMemo(() => makeStyles(Palette, paper), [Palette, paper]);
  return (
    <>
      <View style={styles.blankLine} />
      <Text style={styles.groupLabel}>TICKED OFF THIS WEEK</Text>
    </>
  );
}

// ── Det egna arket ────────────────────────────────────────────────────────

function SheetBody({ title, children, contentStyle, inGrowing = false, keyboardUp = false }: {
  title: string;
  children: ReactNode;
  /** Arkets innehåll tonar in medan arket växer fram ur lappen. */
  contentStyle?: object;
  /** Arket står i det växande skalet, som redan bär `maxHeight`. */
  inGrowing?: boolean;
  /** Tangentbordet står under arket: hemstrecksinsetet är redan täckt. */
  keyboardUp?: boolean;
}) {
  const Palette = usePalette();
  const paper = usePaper();
  const styles = useMemo(() => makeStyles(Palette, paper), [Palette, paper]);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sheet, inGrowing && styles.sheetFull, { paddingBottom: keyboardUp ? 16 : 24 + insets.bottom }]}>
      <View style={[styles.sheetTape, { backgroundColor: paper.tape }]} />
      <Animated.View style={[styles.sheetContent, contentStyle]}>
        <Text style={styles.title}>{title}</Text>
        {children}
      </Animated.View>
    </View>
  );
}

// Arket växer fram ur lappen: det börjar i lappens ruta, i lappens storlek
// och vridning, och blir arket. Stängs det krymper det tillbaka dit. Utan en
// ruta (lappen kunde inte mätas) glider det upp underifrån som förut.
const GROW_MS = 440;
const SHRINK_MS = 300;

export function TodoSheet({
  visible, userId, inCircle, circleCount = 1, origin, onClose, onChanged,
}: {
  visible: boolean;
  userId: string;
  /** Avgör bara fotnoten: vem som ser listan. */
  inCircle: boolean;
  /** Hur många kretsar som ser listan — bara för ordets numerus. */
  circleCount?: number;
  /** Lappens ruta i fönstret, att växa fram ur. */
  origin?: NoteRect | null;
  onClose: () => void;
  /** Den egna listan efter varje ändring, så att lappen kan följa med. */
  onChanged: (todos: Todo[]) => void;
}) {
  const Palette = usePalette();
  const paper = usePaper();
  const styles = useMemo(() => makeStyles(Palette, paper), [Palette, paper]);
  const hand = useHand();

  const [mine, setMine] = useState<Todo[] | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);

  // ── Växandet ──
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  const from = useSharedValue<NoteRect | null>(null);
  const box = useSharedValue({ x: 0, y: 0, w: 0, h: 0 });
  const startedRef = useRef(false);
  const closingRef = useRef(false);

  // Tangentbordets höjd, mätt för hand — samma lösning som circle-chat.tsx.
  // KeyboardAvoidingView gjorde ingenting på Android (`edgeToEdgeEnabled`
  // stänger av `adjustResize`), så fältet låg under tangentbordet.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); setKeyboardHeight(0); };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    progress.value = 0;
    box.value = { x: 0, y: 0, w: 0, h: 0 };
    from.value = origin ?? null;
    startedRef.current = false;
    closingRef.current = false;
  }, [visible, origin, progress, box, from]);

  // Arkets ruta finns först efter layout, så växandet startar där. Senare
  // layouter (tangentbordet) uppdaterar bara rutan.
  const onSheetLayout = (e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    box.value = { x, y, w: width, h: height };
    if (startedRef.current) return;
    startedRef.current = true;
    progress.value = reduceMotion
      ? 1
      : withTiming(1, { duration: GROW_MS, easing: Easing.out(Easing.cubic) });
  };

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Keyboard.dismiss();
    if (reduceMotion) { onClose(); return; }
    progress.value = withTiming(0, { duration: SHRINK_MS, easing: Easing.in(Easing.cubic) });
    setTimeout(onClose, SHRINK_MS);
  }, [reduceMotion, onClose, progress]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const sheetStyle = useAnimatedStyle(() => {
    const b = box.value;
    // Osynligt tills rutan är känd, annars blinkar arket i full storlek.
    if (!b.w) return { opacity: 0 };
    const q = 1 - progress.value;
    const o = from.value;
    if (!o) return { opacity: 1, transform: [{ translateY: q * b.h }] };
    const s0 = o.width / b.w;
    return {
      opacity: 1,
      transform: [
        { translateX: (o.x - b.x) * q },
        { translateY: (o.y - b.y) * q },
        { scale: s0 + (1 - s0) * progress.value },
        { rotate: `${TILT_DEG * q}deg` },
      ],
    };
  });
  // Innehållet tonar in under andra halvan: en lista i lappens storlek är
  // bara krafs, och det är pappret som ska växa, inte texten.
  const contentStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, (progress.value - 0.35) / 0.65)),
  }));

  // Varje ändring går genom den här, så att lappen och arket aldrig visar
  // olika listor. `onChanged` läses ur en ref: kretsfliken skickar en ny pil
  // vid varje omritning (`load()` var fjärde sekund), och som beroende gjorde
  // den att effekten nedan nollade fältet mitt i skrivandet och hämtade om.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const commit = useCallback((next: Todo[]) => {
    setMine(next);
    onChangedRef.current(next);
  }, []);

  useEffect(() => {
    if (!visible) return;
    setDraft('');
    getTodos(userId).then(commit).catch(() => setMine(m => m ?? []));
    track('todo_sheet_opened');
  }, [visible, userId, commit]);

  const open = (mine ?? []).filter(t => !t.done_at);
  const done = sortDone((mine ?? []).filter(t => !!t.done_at));

  const handleAdd = async () => {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      const t = await addTodo(userId, text);
      commit([...(mine ?? []), t]);
      setDraft('');
      // Ingen text i loggen, bara längden — samma linje som chatten.
      track('todo_added', { length: text.length });
    } catch (e: any) {
      Alert.alert('Could not add', e.message);
    } finally {
      setAdding(false);
    }
  };

  // Bocken sätts direkt och rullas tillbaka om skrivningen faller: att trycka
  // och vänta på en bock är precis den tröghet en lista inte får ha.
  const toggle = async (t: Todo) => {
    const before = mine ?? [];
    const nowDone = !t.done_at;
    if (nowDone) {
      // Pappersknäppen: ett hårt tick och ett mjukt efterslag, som när en
      // penna bockar av på papper. Att ångra får bara ett mjukt.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
      setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light), 70);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft);
    }
    commit(before.map(x => x.id === t.id
      ? { ...x, done_at: nowDone ? new Date().toISOString() : null }
      : x));
    try {
      if (nowDone) await completeTodo(t.id); else await reopenTodo(t.id);
      track(nowDone ? 'todo_completed' : 'todo_reopened');
    } catch (e: any) {
      commit(before);
      Alert.alert('Could not save', e.message);
    }
  };

  // Samma optimistiska mönster som bocken.
  const toggleHidden = async (t: Todo) => {
    const before = mine ?? [];
    const hidden = !t.hidden_from_circle;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    commit(before.map(x => x.id === t.id ? { ...x, hidden_from_circle: hidden } : x));
    try {
      await setTodoHidden(t.id, hidden);
      track(hidden ? 'todo_hidden' : 'todo_unhidden');
    } catch (e: any) {
      commit(before);
      Alert.alert('Could not save', e.message);
    }
  };

  const remove = async (t: Todo) => {
    const before = mine ?? [];
    commit(before.filter(x => x.id !== t.id));
    try {
      await deleteTodo(t.id);
      track('todo_deleted', { was_done: !!t.done_at });
    } catch (e: any) {
      commit(before);
      Alert.alert('Could not delete', e.message);
    }
  };

  return (
    // Genomskinliga system-fält, så att modalens koordinater är fönstrets —
    // det är i dem lappen mättes.
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      <View style={[styles.overlayBare, { paddingBottom: keyboardHeight }]}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View style={[styles.growing, sheetStyle]} onLayout={onSheetLayout}>
          <SheetBody title="To do" contentStyle={contentStyle} inGrowing keyboardUp={keyboardHeight > 0}>
            <View style={styles.addRow}>
              <TextInput
                style={[styles.input, hand(16)]}
                value={draft}
                onChangeText={setDraft}
                placeholder="Add something to do…"
                placeholderTextColor={paper.inkSoft}
                maxLength={MAX_LEN}
                returnKeyType="done"
                submitBehavior="submit"
                onSubmitEditing={handleAdd}
              />
              <TouchableOpacity
                style={[styles.addBtn, !draft.trim() && styles.addBtnOff]}
                onPress={handleAdd}
                disabled={!draft.trim() || adding}
                accessibilityRole="button"
                accessibilityLabel="Add to list"
              >
                <FontAwesome name="plus" size={14} color={Palette.onAccent} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={[styles.list, styles.listBleed]}
              contentContainerStyle={styles.listBleedContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Ruled>
                {mine === null ? (
                  <ActivityIndicator color={paper.ink} style={styles.loading} />
                ) : open.length === 0 && done.length === 0 ? (
                  <Text style={[styles.empty, hand(14)]}>Nothing on your list yet.</Text>
                ) : (
                  <>
                    {open.map(t => (
                      <TodoRow key={t.id} todo={t} onToggle={() => toggle(t)} onToggleHidden={() => toggleHidden(t)} onDelete={() => remove(t)} />
                    ))}
                    {done.length > 0 && (
                      <>
                        <GroupLabel />
                        {done.map(t => (
                          <TodoRow key={t.id} todo={t} onToggle={() => toggle(t)} onToggleHidden={() => toggleHidden(t)} onDelete={() => remove(t)} />
                        ))}
                      </>
                    )}
                  </>
                )}
              </Ruled>
            </ScrollView>
            {/* Det här måste stå där man skriver, inte i en inställning: den som
                skriver "ring terapeuten" ska veta vem som läser innan, inte
                efter. */}
            <Text style={styles.footnote}>
              {inCircle
                ? `${circleCount > 1 ? 'Your circles' : 'Your circle'} can see this list${
                    (mine ?? []).some(t => t.hidden_from_circle) ? ', except hidden items' : ''}.`
                : 'Only you see this list until you join a circle.'}
            </Text>
          </SheetBody>
        </Animated.View>
      </View>
    </Modal>
  );
}

function TodoRow({ todo, onToggle, onToggleHidden, onDelete }: {
  todo: Todo;
  onToggle: () => void;
  onToggleHidden: () => void;
  onDelete: () => void;
}) {
  const Palette = usePalette();
  const paper = usePaper();
  const styles = useMemo(() => makeStyles(Palette, paper), [Palette, paper]);
  const hand = useHand();
  const isDone = !!todo.done_at;
  const hidden = todo.hidden_from_circle;
  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={styles.rowMain}
        onPress={onToggle}
        activeOpacity={0.6}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: isDone }}
        accessibilityLabel={todo.text}
      >
        <Check done={isDone} />
        <Text style={[styles.rowText, hand(16), isDone && styles.rowTextDone]}>{todo.text}</Text>
      </TouchableOpacity>
      {/* Ikonen visar läget, som i ett lösenordsfält: öppet öga = kretsen
          ser punkten, överstruket = dold. Båda i fullt bläck. Först var det
          samma överstrukna öga i två styrkor, och det gick inte att avgöra
          vilket läge som var vilket. */}
      <TouchableOpacity
        onPress={onToggleHidden}
        style={styles.hideBtn}
        accessibilityRole="switch"
        accessibilityState={{ checked: hidden }}
        accessibilityLabel={`Hide ${todo.text} from your circle`}
      >
        <FontAwesome5 name={hidden ? 'eye-slash' : 'eye'} size={14} color={paper.ink} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onDelete();
        }}
        style={styles.deleteBtn}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${todo.text}`}
      >
        <FontAwesome name="times" size={17} color={paper.inkSoft} />
      </TouchableOpacity>
    </View>
  );
}

function Check({ done }: { done: boolean }) {
  const Palette = usePalette();
  const paper = usePaper();
  const styles = useMemo(() => makeStyles(Palette, paper), [Palette, paper]);
  return (
    <View style={[styles.check, done && styles.checkOn]}>
      {done && <FontAwesome5 name="check" size={10} color={paper.paper} />}
    </View>
  );
}

// Arket är samma papper som lappen det öppnas från — det ska läsa som att
// lappen lyfts upp, inte som en vanlig modal. Därför läser arket sina färger
// ur `PAPER` och inte ur rummet: bläck och bockar är lappens plommonbruna
// bläck, och arket har tejp i stället för greppstreck. Plusknappen är det
// enda ifyllda, och den är accenten, som allt ifyllt i appen.
// Linjerna och marginalen: tunna och neutrala, i bläckets navy, så att de
// inte tar färg mot något rum. Inte palettstyrda, samma skäl som pappret.
// Hur långt krysset når ut i marginalen. Under Spacing.xl (24), annars
// klipps det mot listans nya kant.
const DELETE_BLEED = 20;
const RULE = 'rgba(10,19,48,0.1)';
const MARGIN = 'rgba(10,19,48,0.22)';

const makeStyles = (Palette: AppPalette, paper: Paper) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: Palette.scrim, justifyContent: 'flex-end' },
  overlayBare: { flex: 1, justifyContent: 'flex-end' },
  scrim: { backgroundColor: Palette.scrim },
  // Pivot i övre vänstra hörnet, så att arkets hörn landar på lappens.
  growing: { transformOrigin: 'left top', maxHeight: '86%' },
  sheet: {
    backgroundColor: paper.paper,
    // Ett papper har nästan raka hörn; 28 läste som systemets ark.
    borderTopLeftRadius: 6, borderTopRightRadius: 6,
    paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg,
    maxHeight: '86%',
  },
  sheetFull: { maxHeight: '100%' },
  sheetContent: { gap: Spacing.md, flexShrink: 1 },
  sheetTape: {
    position: 'absolute', top: -9, alignSelf: 'center',
    width: 72, height: 20, borderRadius: 2,
    transform: [{ rotate: '-2deg' }],
  },
  title: { fontSize: 13, lineHeight: 16, fontWeight: '900', letterSpacing: 1.6, color: paper.inkSoft, textTransform: 'uppercase' },

  addRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  input: {
    flex: 1, minHeight: 46,
    backgroundColor: 'rgba(255,255,255,0.4)', borderRadius: Radius.md,
    paddingHorizontal: 14, paddingVertical: 8,
    fontSize: 16, color: paper.ink,
  },
  addBtn: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: Palette.accent, alignItems: 'center', justifyContent: 'center',
  },
  addBtnOff: { opacity: 0.4 },

  // Växer med innehållet men krymper när arket når sin `maxHeight`, så att
  // fältet och fotnoten alltid står kvar.
  list: { flexGrow: 0, flexShrink: 1 },
  // Listan når ut till arkets kant; innehållet står kvar där det stod.
  listBleed: { marginRight: -Spacing.xl },
  listBleedContent: { paddingRight: Spacing.xl - DELETE_BLEED },
  ruled: { minHeight: MIN_LINES * LINE },
  rule: { position: 'absolute', left: 0, right: DELETE_BLEED, height: StyleSheet.hairlineWidth * 2, backgroundColor: RULE },
  margin: { position: 'absolute', top: 0, bottom: 0, left: MARGIN_X, width: StyleSheet.hairlineWidth * 2, backgroundColor: MARGIN },
  blankLine: { height: LINE },
  loading: { height: LINE * 2 },
  empty: {
    height: LINE, lineHeight: LINE, paddingLeft: MARGIN_X + 6,
    fontSize: 14, color: paper.inkSoft,
    transform: [{ translateY: TEXT_DROP }],
  },
  footnote: { fontSize: 12, lineHeight: 16, color: paper.inkSoft, textAlign: 'center' },
  groupLabel: {
    height: LINE, lineHeight: LINE, paddingLeft: MARGIN_X + 6,
    fontSize: 11, fontWeight: '900', letterSpacing: 1.2, color: paper.inkSoft,
    transform: [{ translateY: TEXT_DROP + 2 }],
  },

  // Allt fäst vid radens första linje: en punkt som bryter blir två `LINE`,
  // och centrerade hade bocken, ögat och krysset hamnat mitt emellan — rakt
  // på linjen mellan raderna.
  row: { flexDirection: 'row', alignItems: 'flex-start', minHeight: LINE },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  roRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, minHeight: LINE },
  rowText: {
    flex: 1, fontSize: 16, lineHeight: LINE, color: paper.ink,
    transform: [{ translateY: TEXT_DROP }],
  },
  rowTextDone: { color: paper.inkSoft, textDecorationLine: 'line-through' },
  // Ögat och krysset har var sin fasta ruta och ingen `hitSlop`: med hitSlop
  // på båda överlappade tryckytorna, och ett tryck på ögat raderade punkten.
  // Rutorna står kant i kant men överlappar inte; ögat ligger i högra delen
  // av sin ruta och krysset längst ut i sin, så det är ikonerna som står nära.
  hideBtn: { width: 40, height: LINE, marginLeft: 4, paddingRight: 8, alignItems: 'flex-end', justifyContent: 'center' },
  // Krysset sträcker sig `DELETE_BLEED` ut i arkets marginal, med samma tal i
  // paddingRight så att ikonen står kvar. Det var en `hitSlop` åt höger förut,
  // men Android levererar aldrig tryck utanför förälderns ram — och listan
  // slutade precis vid ikonen — så tryck strax bredvid krysset gick till
  // arket och "ingenting hände". Därför går listan och raderna ut i
  // marginalen (`listBleed`), linjerna dras in lika mycket (`rule`), och
  // knappen är faktiskt bred. Ingen negativ marginal på knappen: då sticker
  // den ut ur sin rad, och samma Android-regel slår till ett led upp.
  deleteBtn: { height: LINE, width: 36 + DELETE_BLEED, paddingRight: DELETE_BLEED, marginLeft: 0, alignItems: 'flex-end', justifyContent: 'center' },

  // Bocken är bläcket, som rutorna på kretsens lappar — aldrig lådans gröna.
  // Den står i marginalen, till vänster om den röda linjen.
  check: {
    width: 22, height: 22, borderRadius: 11, marginTop: (LINE - 22) / 2,
    borderWidth: 2, borderColor: paper.ink,
    alignItems: 'center', justifyContent: 'center',
  },
  checkOn: { backgroundColor: paper.ink },

  // Kretsens lappar. Luft över och under raden så att tejpen och vridningens
  // hörn inte klipps av rullningen.
  // Raden går kant i kant (anroparen drar ut den med negativ marginal), och
  // indraget är sidans egen marginal. Då syns det att raden går att rulla.
  notesRow: { gap: CN_GAP, paddingTop: 14, paddingBottom: 10, paddingHorizontal: Spacing.xl },
  note: {
    width: CN_W, minHeight: CN_H,
    borderRadius: 3,
    paddingHorizontal: 12, paddingTop: 16, paddingBottom: 12,
    gap: 7,
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2, shadowRadius: 6, elevation: 4,
  },
  noteDimmed: { opacity: 0.38 },
  tape: {
    position: 'absolute', top: -8, alignSelf: 'center',
    width: 46, height: 16, borderRadius: 2,
    transform: [{ rotate: '-3deg' }],
  },
  noteName: { fontSize: 11, lineHeight: 14, fontWeight: '900', letterSpacing: 1.3, marginBottom: 2 },
  noteEmpty: { fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  noteItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  noteBox: {
    width: 12, height: 12, borderRadius: 2, borderWidth: 1.5, marginTop: 3,
    alignItems: 'center', justifyContent: 'center',
  },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  strike: { textDecorationLine: 'line-through', fontWeight: '400' },
  noteMore: { fontSize: 12, lineHeight: 16, fontWeight: '700', marginTop: 'auto' },
});
