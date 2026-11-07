import { FontAwesome5 } from '@expo/vector-icons';
import type { BottomTabNavigationOptions } from '@react-navigation/bottom-tabs';
import { Tabs, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Easing, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RoomTabBar } from '../../components/room-tab-bar';
import { useAuth } from '../../contexts/AuthContext';
import { countUnreadCircleMessages } from '../../lib/circleChat';
import { safeBottom } from '../../lib/bottomInset';
import { CIRCLE_MAX_PER_USER, getMyCircles } from '../../lib/circles';
import { useHomeMode } from '../../lib/homeMode';
import { countOpenPauseInvites } from '../../lib/pauseInvites';
import { supabase } from '../../lib/supabase';
import { unopenedResponsesQuery } from '../../lib/supportStories';
import { usePalette, useTheme } from '../../contexts/ThemeContext';
import { RoomName, roomPalette } from '../../constants/appTheme';

// Golvet för botteninsetet på Android bor i lib/bottomInset.ts — se där.

/**
 * Luft under etiketterna utöver systemets inset — själva lyftet.
 *
 * Höjden växer med exakt samma tal, så innehållsytan (ikon + etikett) förblir
 * 44 punkter. Raden blir alltså högre och står längre upp; knapparna krymper
 * inte.
 */
const TAB_LIFT = 10;

/**
 * Taket på brickans siffra.
 *
 * Samma tal och samma form som inkorgsbrickorna i Friends-fliken redan
 * använder (`pendingQuiet > 9 ? '9+' : …`). Brickan har fast höjd, och ett
 * tresiffrigt tal i en 18-punktscirkel är den andra sidan av samma bugg som
 * typskalans golv finns för att hindra — siffran får inte bli oläslig för att
 * den inte får plats.
 */
const BADGE_MAX = 9;

/**
 * Bytet mellan flikarna: den nya sidan glider in 28 px från sitt håll och
 * tonar upp, den gamla glider ut åt andra hållet och tonar bort — 500 ms.
 * Det är bottom-tabs egen `shift`-övergång med designreferensens tal i
 * stället för bibliotekets 50 px, och den kör på native-drivern.
 *
 * Med reducerad rörelse används ingen övergång alls (`animation: 'none'`).
 */
const TAB_SHIFT_PX = 28;
const TAB_TRANSITION: Pick<BottomTabNavigationOptions, 'sceneStyleInterpolator' | 'transitionSpec'> = {
  transitionSpec: {
    animation: 'timing',
    config: { duration: 500, easing: Easing.bezier(0.2, 0.7, 0.2, 1) },
  },
  sceneStyleInterpolator: ({ current }) => ({
    sceneStyle: {
      opacity: current.progress.interpolate({ inputRange: [-1, 0, 1], outputRange: [0, 1, 0] }),
      transform: [{
        translateX: current.progress.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [-TAB_SHIFT_PX, 0, TAB_SHIFT_PX],
        }),
      }],
    },
  }),
};

/**
 * Pause-flikens ikon: pausens två streck ritade för hand, som appikonen —
 * rundade, och glappet lika brett som ett streck. FontAwesomes `pause` hade
 * kantiga streck och ett smalare glapp.
 */
function PauseTabIcon({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      <View style={{ width: 6, height: 19, borderRadius: 3, backgroundColor: color }} />
      <View style={{ width: 6, height: 19, borderRadius: 3, backgroundColor: color }} />
    </View>
  );
}

const badgeLabel = (n: number): string | undefined =>
  n <= 0 ? undefined : n > BADGE_MAX ? `${BADGE_MAX}+` : String(n);

/**
 * Vilket rum raden står i.
 *
 * Flikraden är ett enda element som ligger kvar medan flikarna byts, så den kan
 * inte ligga inuti någon `RoomProvider` — den måste läsa rummet ur rutten i
 * stället. `usePathname()` finns redan här för brickornas skull.
 *
 * Raden tar rummets `bg` och den aktiva ikonen dess `hue`. Brickorna gör det
 * inte: de är ifyllda, och det ifyllda är alltid accenten.
 */
const ROOM_BY_PATH: Record<string, RoomName> = {
  '/': 'pause',
  '/circle': 'circle',
  '/friends': 'friends',
};

export default function TabLayout() {
  const Palette = usePalette();
  const { mode } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomInset = safeBottom(insets.bottom);
  const { user } = useAuth();
  const pathname = usePathname();
  // Hem i nattläge står i `night`-rummet, och botten bakom scenerna följer
  // med (lib/homeMode.ts) — samma val som flikraden gör.
  const homeMode = useHomeMode();
  const pathRoom = ROOM_BY_PATH[pathname] ?? 'pause';
  const Room = roomPalette(mode, pathname === '/' && homeMode === 'night' ? 'night' : pathRoom);
  const reduceMotion = useReducedMotion();
  const [requestCount, setRequestCount] = useState(0);
  const [inviteCount, setInviteCount] = useState(0);
  const [circleInviteCount, setCircleInviteCount] = useState(0);
  const [circleUnreadChat, setCircleUnreadChat] = useState(0);
  const [messageCount, setMessageCount] = useState(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  /**
   * En stil för båda brickorna. De var två byte-identiska kopior, och två
   * brickor på samma rad som ser olika ut är värre än en bricka som ser fel
   * ut — samma skäl som veckoknappen i Kretsen och dess tvilling i
   * statistiken delar mått.
   *
   * `paddingHorizontal` är nytt och är vad `9+` behöver: brickan har fast
   * höjd och `minWidth: 18`, så ett andra tecken hade skurits av mot kanten.
   * Höjden rörs inte — det är bredden som ska växa med texten.
   */
  const badgeStyle = {
    backgroundColor: Palette.accent,
    fontSize: 11,
    minWidth: 18,
    height: 18,
    lineHeight: 18,
    paddingHorizontal: 4,
  };

  const fetchCount = () => {
    if (!user) { setRequestCount(0); return; }
    supabase
      .from('friendships')
      .select('id', { count: 'exact', head: true })
      .eq('receiver_id', user.id)
      .eq('status', 'pending')
      .then(({ count }) => setRequestCount(count ?? 0));
  };

  // Öppna pausinbjudningar — samma fråga som korten i Friends, så att
  // brickan räknar exakt det fliken visar. En inbjudan vars push föll bort
  // i nattfönstret (supabase/social_notify.sql) syns ändå här.
  const fetchInviteCount = () => {
    if (!user) { setInviteCount(0); return; }
    countOpenPauseInvites(user.id).then(setInviteCount).catch(() => {});
  };

  // Stöd-svaren låg som knappar på Hem förut och syntes därmed direkt vid
  // start. Nu bor de i Community, så de måste räknas in i flikens badge —
  // annars ser man dem bara om man råkar gå dit. Svaren överlever
  // förfrågan, så alla egna stories räknas — också utgångna och borttagna.
  const fetchMessageCount = () => {
    if (!user) { setMessageCount(0); return; }
    unopenedResponsesQuery(user.id, 'id', { count: 'exact', head: true })
      .then(({ count }) => setMessageCount(count ?? 0));
  };

  /**
   * Kretsflikens bricka — **en** fråga med samma gren som fliken själv.
   *
   * Grenen är hela poängen, och den är rättad två gånger om:
   *
   * 1. Olästa chattmeddelanden räknades inte alls. Brickan räknade bara
   *    kretsinbjudningar, så ett läst chattmeddelande kunde omöjligt få den
   *    att slockna. Så länge brickan stod som ett `?` gick det inte att se —
   *    ett frågetecken ser likadant ut vad det än står för.
   * 2. Inbjudningar räknades **villkorslöst**, men fliken visar dem bara
   *    när de går att besvara. Den som inte kunde gå med i fler kretsar fick
   *    därför en bricka som ingenting i gränssnittet kunde släcka. En bricka
   *    som räknar något man inte kan nå är exakt det `?` dolde.
   *
   * Regeln som följer: **brickan räknar det fliken visar**. Står det en
   * siffra ska det finnas något att trycka på. Ändras grenen i `load()` i
   * [app/(tabs)/circle.tsx](app/(tabs)/circle.tsx) ska den ändras här.
   *
   * Med upp till tre kretsar blir grenen: olästa räknas i **varje** krets man
   * är med i, och inbjudningar räknas så länge det finns plats för en till —
   * det är då fliken visar dem (bakom `+` i kretsraden, eller i tomvyn). Med
   * tre kretsar ligger de kvar som `pending` och kommer tillbaka den dag man
   * lämnar en; de är inte avfärdade, bara inte räknade medan de ändå inte går
   * att besvara.
   */
  const fetchCircleBadge = async () => {
    if (!user) { setCircleInviteCount(0); setCircleUnreadChat(0); return; }

    const mine = await getMyCircles(user.id);

    if (mine.length < CIRCLE_MAX_PER_USER) {
      const { count } = await supabase
        .from('circle_invites')
        .select('id', { count: 'exact', head: true })
        .eq('invitee_id', user.id)
        .eq('status', 'pending');
      setCircleInviteCount(count ?? 0);
    } else {
      setCircleInviteCount(0);
    }

    // `chat_read_at` är läsmärket och `joined_at` reservvärdet för den som
    // aldrig öppnat chatten — annars möts en nykomling av hela historiken som
    // olästa. Egna meddelanden räknas inte; den regeln sitter i
    // `countUnreadCircleMessages`.
    const unread = await Promise.all(mine.map(c =>
      countUnreadCircleMessages(c.id, c.chat_read_at ?? c.joined_at, user.id)));
    setCircleUnreadChat(unread.reduce((a, n) => a + n, 0));
  };

  useEffect(() => {
    fetchCount();
    fetchInviteCount();
    fetchCircleBadge();
    fetchMessageCount();
  }, [user, pathname]);

  // Polling som backup — garanterar snabb uppdatering även om realtime missar
  useEffect(() => {
    if (!user) return;
    const poll = setInterval(() => {
      fetchCount(); fetchInviteCount(); fetchCircleBadge(); fetchMessageCount();
    }, 2000);
    return () => clearInterval(poll);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    const channel = supabase
      .channel(`tab-friendships-${user.id}-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, fetchCount)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pause_invites' }, fetchInviteCount)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'circle_invites' }, fetchCircleBadge)
      // `circle_messages` ligger i publikationen `supabase_realtime` (till
      // skillnad från `profiles` — skillnaden är RLS, se circle_chat.sql), så
      // en ny rad når hit direkt. `circle_members` är med för läsmärket:
      // `mark_circle_chat_read` skriver `chat_read_at` där, och det är den
      // skrivningen som ska släcka brickan när man läst.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'circle_messages' }, fetchCircleBadge)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'circle_members' }, fetchCircleBadge)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'support_responses' }, fetchMessageCount)
      .subscribe();
    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [user]);

  // 60 + TAB_LIFT i höjd och samma TAB_LIFT i botten: ytan mellan
  // paddningarna blir kvar på 44 punkter, så ikon och etikett har lika mycket
  // plats som förut — det är bara raden som blir högre och lyfter dem ovanför
  // systemets knappar.
  const barHeight = 60 + TAB_LIFT + bottomInset;
  const barPaddingBottom = bottomInset + 8 + TAB_LIFT;

  return (
    // Botten bakom scenerna, i rummet man är på väg till. Medan två sidor
    // tonar i varandra är båda delvis genomskinliga, och utan en egen botten
    // hade navigatorns förvalda (vita) syntes igenom mitt i bytet.
    <View style={{ flex: 1, backgroundColor: Room.bg }}>
    <Tabs
      // Raden ritas av appen för den glidande markeringens skull, se
      // components/room-tab-bar.tsx. Ikoner, etiketter och brickor läses
      // fortfarande ur varje skärms `options` nedan.
      tabBar={props => (
        <RoomTabBar {...props} height={barHeight} paddingBottom={barPaddingBottom} />
      )}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: 'transparent' },
        ...(reduceMotion ? { animation: 'none' } : TAB_TRANSITION),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Pause',
          tabBarIcon: ({ color }) => (
            <PauseTabIcon color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="circle"
        options={{
          title: 'Circle',
          // En ring, och inte ännu en folkhop. Kretsen och vänfliken bar förr
          // var sin klump av människor (`people-circle-outline` respektive
          // `user-friends`), och vid 20 punkter är det samma bild. Ringen är
          // ordet självt och den form hela ytan är byggd av; den ersatte
          // `layer-group` (stegen) på begäran. FontAwesome5 utan `solid` ger
          // kontur — en fylld skiva hade läst som en knapp eller en prick.
          tabBarIcon: ({ color }) => (
            <FontAwesome5 name="circle" size={19} color={color} />
          ),
          // Siffran och inte ett `?`. Frågetecknet sa bara "något finns", och
          // det gick därför inte att se att brickan räknade EN sak (inbjudan)
          // medan användaren läste den som en annan (chatten) — den stod kvar
          // efter ett läst meddelande och såg ut som en bugg. En siffra måste
          // gå ihop, och summan nedan är vad fliken faktiskt har osett:
          // inbjudningar att svara på plus olästa i chatten.
          tabBarBadge: badgeLabel(circleInviteCount + circleUnreadChat),
          tabBarBadgeStyle: badgeStyle,
        }}
      />
      <Tabs.Screen
        name="friends"
        options={{
          // Fliken heter Support: stödet är sidans huvudsak, och vänlistan är
          // vilka man kan be om det. Rutten och rummet heter fortfarande
          // `friends`, samma linje som `Palette.community`.
          title: 'Support',
          tabBarIcon: ({ color }) => (
            <FontAwesome5 name="hand-holding-heart" size={18} color={color} />
          ),
          // Samma siffra som i Circle. De tre talen är vänförfrågningar,
          // pausinbjudningar och oöppnade stödsvar — allt som väntar på ett
          // svar från dig i den här fliken, och inget som bara hänt.
          tabBarBadge: badgeLabel(requestCount + inviteCount + messageCount),
          tabBarBadgeStyle: badgeStyle,
        }}
      />
    </Tabs>
    </View>
  );
}
