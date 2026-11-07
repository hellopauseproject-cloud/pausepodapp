import { FontAwesome5, Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, Keyboard, Linking, PanResponder, Pressable, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OpensPicker, SealedSendOverlay, SEALED_SEND_MS } from '../components/opens-picker';
import { useAuth } from '../contexts/AuthContext';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import {
  CAPTION_BAND_PADDING, CAPTION_DEFAULT_Y, CAPTION_FONT_SIZE, CAPTION_LINE_HEIGHT,
  CAPTION_MAX_LEN, clampCaptionY,
} from '../lib/photoCaption';
import { uploadSupportMedia } from '../lib/supportMedia';
import { AppPalette, alpha } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';

const PHOTO_QUALITY = 0.7;

type Phase = 'camera' | 'editing' | 'uploading' | 'sent';

export default function SupportRespondPhotoScreen() {
  const Palette = usePalette();
  const st = useMemo(() => makeSt(Palette), [Palette]);
  const { user } = useAuth();
  const { storyId, ownerName } = useLocalSearchParams<{ storyId: string; ownerName: string }>();
  const [sealed, setSealed] = useState(false);
  const insets = useSafeAreaInsets();

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [phase, setPhase] = useState<Phase>('camera');
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const [caption, setCaption] = useState('');
  const [captionOn, setCaptionOn] = useState(false);
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionY, setCaptionY] = useState(CAPTION_DEFAULT_Y);
  const [frameH, setFrameH] = useState(0);
  const [bandH, setBandH] = useState(0);
  const [keyboardH, setKeyboardH] = useState(0);
  const captionInputRef = useRef<TextInput>(null);

  // Draget behöver det färska värdet utan att PanResponder-handlarna skrivs om
  // vid varje pixel — en responder som återskapas mitt i en rörelse tappar den.
  const captionYRef = useRef(CAPTION_DEFAULT_Y);
  const dragStartYRef = useRef(CAPTION_DEFAULT_Y);
  const frameHRef = useRef(0);

  useEffect(() => {
    if (!cameraPermission) return;
    if (!cameraPermission.granted && cameraPermission.canAskAgain) requestCameraPermission();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraPermission?.status]);

  // Tangentbordets höjd läses av, inte gissas: bandet ska ligga ovanför det
  // medan man skriver, annars skriver man i en rad man inte ser.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e => setKeyboardH(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardH(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Ett tryck ska fokusera textfältet och ett drag ska flytta bandet, så
  // responderns grind är rörelsen och inte beröringen: onStart säger nej,
  // onMove säger ja först när fingret faktiskt gått någonstans.
  // Capture-varianten och inte den vanliga: bandet innehåller ett fokuserat
  // TextInput, och ett fält som redan har responderen släpper den inte till
  // sin förälder. Med capture får föräldern frågan först — men bara när
  // fingret rört sig, så ett tryck går fortfarande hela vägen ner till fältet.
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dy) > 6,
    onPanResponderGrant: () => { dragStartYRef.current = captionYRef.current; },
    onPanResponderMove: (_, g) => {
      const h = frameHRef.current;
      if (!h) return;
      const next = clampCaptionY(dragStartYRef.current + g.dy / h);
      captionYRef.current = next;
      setCaptionY(next);
    },
  }), []);

  const resetToCamera = () => {
    setPhotoUri(null);
    setCaption('');
    setCaptionOn(false);
    setEditingCaption(false);
    setCaptionY(CAPTION_DEFAULT_Y);
    captionYRef.current = CAPTION_DEFAULT_Y;
    setErrorMsg('');
    setPhase('camera');
  };

  const takePhoto = async () => {
    if (!cameraRef.current) return;
    try {
      const shot = await cameraRef.current.takePictureAsync({ quality: PHOTO_QUALITY });
      if (shot?.uri) { setPhotoUri(shot.uri); setPhase('editing'); }
    } catch (e: any) {
      setErrorMsg('Could not take the photo: ' + (e?.message ?? 'unknown error'));
    }
  };

  const pickPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: PHOTO_QUALITY,
    });
    if (!result.canceled && result.assets[0]) {
      setPhotoUri(result.assets[0].uri);
      setPhase('editing');
    }
  };

  const startCaption = () => {
    setCaptionOn(true);
    setEditingCaption(true);
    // Fältet finns inte i trädet förrän captionOn är sant, så fokus får vänta
    // på nästa rendering.
    setTimeout(() => captionInputRef.current?.focus(), 50);
  };

  const endCaption = () => {
    setEditingCaption(false);
    Keyboard.dismiss();
    // En tom rad är ingen rad: bandet försvinner hellre än står kvar tomt och
    // ser ut som ett fel i bilden.
    if (!caption.trim()) { setCaptionOn(false); setCaption(''); }
  };

  const handleSend = async () => {
    if (!user || !photoUri || !storyId) return;
    Keyboard.dismiss();
    setEditingCaption(false);
    setPhase('uploading');
    const text = caption.trim();
    // Vilket av de två stegen som föll avgör vad man ska göra åt det: en
    // upload som faller är nät eller behörighet, en insert som faller är
    // schemat (en kolumn som saknas syns som "could not find ... in the schema
    // cache"). Ett gemensamt "Upload error" på båda pekade åt fel håll.
    let step: 'upload' | 'save' = 'upload';
    try {
      const path = `${user.id}/${Date.now()}.jpg`;
      const contentUrl = await uploadSupportMedia(photoUri, path, 'image/jpeg');
      step = 'save';

      const { error: dbError } = await supabase.from('support_responses').insert({
        story_id: storyId,
        sender_id: user.id,
        response_type: 'photo',
        content_url: contentUrl,
        // Samma kolumn som textsvaret använder. Bildtexten är text, och en
        // egen kolumn för samma sorts innehåll hade bara gett två ställen att
        // leta på.
        text_content: text || null,
        caption_y: text ? captionYRef.current : null,
        // Försluten tills mottagaren gjort en paus (supabase/support_sealed.sql).
        // Bara när den är vald, så att *Now* fungerar mot en databas utan kolumnen.
        ...(sealed ? { opens_after_pause: true } : {}),
      });
      if (dbError) throw dbError;

      // Längden, inte texten — samma linje som textsvaret: orden bor i
      // support_responses, och en kopia i app_events hade gjort en raderad rad
      // till en rad som finns kvar någon annanstans.
      track('support_response_sent', { response_type: 'photo', length: text.length, sealed });
      setPhase('sent');
      setTimeout(() => router.back(), sealed ? SEALED_SEND_MS : 900);
    } catch (e: any) {
      const what = step === 'upload' ? 'Could not upload the photo' : 'Could not send the photo';
      setErrorMsg(what + ': ' + (e?.message ?? JSON.stringify(e)));
      setPhase('editing');
    }
  };

  // ─── Behörighet ────────────────────────────────────────────────────────
  // `!photoUri` i villkoret är inte en detalj: biblioteksknappen nedan finns
  // just för den som sagt nej till kameran, och utan den halvan hade ett
  // valt foto satt `phase` till editing medan skärmen stod kvar på
  // behörighetsfrågan — bilden hade försvunnit i tomma intet.
  if (!cameraPermission?.granted && !photoUri) {
    const permanentlyDenied = cameraPermission?.canAskAgain === false;
    return (
      <View style={[st.permContainer, { paddingBottom: insets.bottom + 24 }]}>
        <FontAwesome5 name="camera" size={36} color={alpha(Palette.community, 0.5)} />
        {permanentlyDenied ? (
          <>
            <Text style={st.permText}>
              Camera access was denied.{'\n'}Enable it in Settings → Apps → Privacy.
            </Text>
            <Pressable style={st.permBtn} onPress={() => Linking.openSettings()}>
              <Text style={st.permBtnText}>Open settings</Text>
            </Pressable>
          </>
        ) : (
          <Text style={st.permText}>Requesting camera permission…</Text>
        )}
        {/* Biblioteket kräver ingen kamera, så vägen dit står öppen även för
            den som sagt nej till den. */}
        <Pressable style={st.permGhostBtn} onPress={pickPhoto}>
          <FontAwesome5 name="images" size={13} color={Palette.ink70} />
          <Text style={st.permGhostText}>Choose from library</Text>
        </Pressable>
        <Pressable onPress={() => router.back()} style={[st.closeBtn, { top: insets.top + 12 }]}>
          <FontAwesome5 name="chevron-left" size={15} color="#fff" />
        </Pressable>
      </View>
    );
  }

  // Bandets läge medan man skriver: klampat så att det aldrig hamnar under
  // tangentbordet. Resten av tiden står det där det släpptes.
  const bandTop = (() => {
    const placed = captionY * frameH - bandH / 2;
    if (!editingCaption || !keyboardH || !frameH || !bandH) return placed;
    return Math.min(placed, frameH - keyboardH - bandH - 16);
  })();

  return (
    <View style={st.container}>
      <TouchableOpacity
        onPress={() => (phase === 'editing' ? resetToCamera() : router.back())}
        style={[st.closeBtn, { top: insets.top + 12 }]}
        activeOpacity={0.7}
      >
        <FontAwesome5 name="chevron-left" size={15} color="#fff" />
      </TouchableOpacity>

      <Text style={[st.title, { top: insets.top + 16 }]}>Support for {ownerName}</Text>

      {phase === 'camera' && (
        <TouchableOpacity
          onPress={() => setFacing(f => (f === 'front' ? 'back' : 'front'))}
          style={[st.flipBtn, { top: insets.top + 12 }]}
          activeOpacity={0.7}
        >
          <Ionicons name="camera-reverse-outline" size={22} color="#fff" />
        </TouchableOpacity>
      )}

      {phase === 'editing' && !!photoUri && !editingCaption && (
        <TouchableOpacity
          onPress={startCaption}
          style={[st.flipBtn, { top: insets.top + 12 }]}
          activeOpacity={0.7}
          accessibilityLabel={captionOn ? 'Edit the text on the photo' : 'Add text to the photo'}
        >
          <Text style={st.textToolGlyph}>Aa</Text>
        </TouchableOpacity>
      )}

      <View
        style={st.frame}
        onLayout={e => {
          const h = e.nativeEvent.layout.height;
          setFrameH(h);
          frameHRef.current = h;
        }}
      >
        {phase === 'camera' ? (
          <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} mode="picture" />
        ) : photoUri ? (
          <>
            {/* `cover` på båda sidorna: avsändarens och mottagarens skärmar är
                sällan lika höga, och bildtextens läge är en andel av ytan.
                Byter man resizeMode här måste visningsskärmen byta likadant,
                annars glider raden i förhållande till motivet. */}
            <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />

            {/* Ett tryck utanför bandet lämnar skrivläget — annars är Done på
                tangentbordet enda vägen ut, och på Android finns den inte. */}
            {editingCaption && (
              <Pressable style={StyleSheet.absoluteFill} onPress={endCaption} />
            )}

            {captionOn && (
              <View
                style={[st.captionBand, { top: bandTop }]}
                onLayout={e => setBandH(e.nativeEvent.layout.height)}
                {...pan.panHandlers}
              >
                <TextInput
                  ref={captionInputRef}
                  style={st.captionInput}
                  value={caption}
                  onChangeText={t => { if (t.length <= CAPTION_MAX_LEN) setCaption(t); }}
                  placeholder="Say something…"
                  placeholderTextColor="rgba(255,255,255,0.5)"
                  multiline
                  maxLength={CAPTION_MAX_LEN}
                  textAlign="center"
                  onFocus={() => setEditingCaption(true)}
                  onBlur={endCaption}
                  editable={phase === 'editing'}
                />
              </View>
            )}

            {captionOn && editingCaption && (
              <Text style={[st.dragHint, { bottom: (keyboardH || 0) + 16 }]}>
                Drag the text to move it
              </Text>
            )}
          </>
        ) : null}
      </View>

      <View style={[st.controls, { paddingBottom: insets.bottom + 32 }]}>
        {phase === 'camera' && (
          <>
            <Text style={st.hint}>Tap to take a photo</Text>
            <View style={st.shutterRow}>
              <TouchableOpacity
                style={st.libraryBtn}
                onPress={pickPhoto}
                activeOpacity={0.75}
                accessibilityLabel="Choose a photo from your library"
              >
                <FontAwesome5 name="images" size={17} color={Palette.ink70} />
              </TouchableOpacity>
              <TouchableOpacity style={st.shutterBtn} onPress={takePhoto} activeOpacity={0.85}>
                <View style={st.shutterInner} />
              </TouchableOpacity>
              {/* Spegeln av biblioteksknappen, så slutaren hamnar i mitten av
                  raden och inte bredvid den. */}
              <View style={st.shutterSpacer} />
            </View>
          </>
        )}

        {phase === 'editing' && !editingCaption && (
          <OpensPicker sealed={sealed} onChange={setSealed} ownerName={ownerName ?? ''} onDark />
        )}
        {phase === 'editing' && !editingCaption && (
          <View style={st.reviewActions}>
            <TouchableOpacity style={st.retakeBtn} onPress={resetToCamera} activeOpacity={0.75}>
              <FontAwesome5 name="redo" size={13} color={Palette.ink70} />
              <Text style={st.retakeText}>Retake</Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.sendBtn} onPress={handleSend} activeOpacity={0.85}>
              <FontAwesome5 name="paper-plane" size={13} color="#fff" />
              <Text style={st.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === 'uploading' && (
          <View style={{ alignItems: 'center', gap: 12 }}>
            <ActivityIndicator color={Palette.community} size="large" />
            <Text style={st.hint}>Uploading…</Text>
          </View>
        )}

        {phase === 'sent' && (
          <View style={{ alignItems: 'center', gap: 12 }}>
            <View style={st.sentIcon}>
              <FontAwesome5 name="check" size={24} color="#fff" />
            </View>
            <Text style={st.hint}>Sent!</Text>
          </View>
        )}

        {!!errorMsg && (
          <View style={st.errorBox}>
            <Text style={st.errorText}>{errorMsg}</Text>
          </View>
        )}
      </View>
      {phase === 'sent' && sealed && <SealedSendOverlay />}
    </View>
  );
}

// Samma undantag som video.tsx och support-respond-video.tsx: bakgrunden är
// kamerabilden eller fotot, inte en yta appen målar, så chromet ovanpå den
// måste stå kvar mot en bild vi inte känner färgen på. De vita och svarta
// literalerna här är alltså med flit literaler.
const makeSt = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  closeBtn: { position: 'absolute', left: 16, zIndex: 10, padding: 14 },
  flipBtn: { position: 'absolute', right: 20, zIndex: 10, padding: 10 },
  textToolGlyph: { color: '#fff', fontSize: 19, fontWeight: '900', letterSpacing: 0.5 },
  title: {
    position: 'absolute', alignSelf: 'center', zIndex: 10,
    color: '#fff', fontSize: 15, fontWeight: '600',
  },
  frame: { flex: 1, overflow: 'hidden' },

  // Snapchats band: full bredd, svagt mörkad botten, vit text centrerad. Den
  // mörka remsan är inte dekoration — utan den försvinner vit text i en vit
  // himmel, och bilden är någon annans.
  captionBand: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingVertical: CAPTION_BAND_PADDING, paddingHorizontal: 20,
  },
  captionInput: {
    color: '#fff', fontSize: CAPTION_FONT_SIZE, lineHeight: CAPTION_LINE_HEIGHT,
    fontWeight: '600', textAlign: 'center', padding: 0,
  },
  dragHint: {
    position: 'absolute', alignSelf: 'center',
    color: 'rgba(255,255,255,0.75)', fontSize: 12, letterSpacing: 0.4,
  },

  controls: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: 32,
    alignItems: 'center', gap: 16,
    backgroundColor: Palette.scrim,
    paddingTop: 20,
  },
  hint: { color: Palette.ink70, fontSize: 14 },

  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' },
  libraryBtn: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Palette.ink15, borderWidth: 1, borderColor: Palette.ink40,
  },
  shutterSpacer: { width: 48, height: 48 },
  shutterBtn: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 4, borderColor: Palette.ink30,
    backgroundColor: Palette.community,
  },
  shutterInner: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#fff',
  },

  // Speglar röst- och videoskärmarnas par: samma höjd, radie och ikonstorlek,
  // så de tre svarsflödena känns som samma skydd mot något man inte vill
  // skicka. Tonerna är videons, för knappen ligger över en bild och inte mot
  // appens botten.
  reviewActions: { flexDirection: 'row', gap: 16, width: '100%' },
  retakeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 28,
    borderWidth: 1, borderColor: Palette.ink40,
    backgroundColor: Palette.ink15,
  },
  retakeText: { color: Palette.ink70, fontSize: 14, fontWeight: '600' },
  sendBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 28, backgroundColor: Palette.community,
  },
  sendBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  sentIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: Palette.success, alignItems: 'center', justifyContent: 'center',
  },
  errorBox: {
    backgroundColor: alpha(Palette.danger, 0.12), borderRadius: 12,
    borderWidth: 1, borderColor: alpha(Palette.danger, 0.3),
    padding: 12, width: '100%',
  },
  errorText: { color: Palette.danger, fontSize: 13, textAlign: 'center', lineHeight: 18 },

  permContainer: {
    flex: 1, backgroundColor: Palette.bg,
    alignItems: 'center', justifyContent: 'center',
    padding: 40, gap: 20,
  },
  permText: { color: Palette.ink70, fontSize: 16, textAlign: 'center', lineHeight: 24 },
  permBtn: {
    backgroundColor: Palette.community, paddingVertical: 14, paddingHorizontal: 36,
    borderRadius: 28, marginTop: 8,
  },
  permBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  permGhostBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 24, borderRadius: 28,
    borderWidth: 1, borderColor: Palette.ink40, backgroundColor: Palette.ink15,
  },
  permGhostText: { color: Palette.ink70, fontSize: 14, fontWeight: '600' },
});
