import { FontAwesome5 } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openPauseStart } from '../lib/pauseFlow';
import { supabase } from '../lib/supabase';
import {
  CAPTION_BAND_PADDING, CAPTION_DEFAULT_Y, CAPTION_FONT_SIZE, CAPTION_LINE_HEIGHT,
} from '../lib/photoCaption';
import { AppPalette, Radius } from '../constants/appTheme';
import { usePalette } from '../contexts/ThemeContext';
import { SupportHeartButton } from '../components/support-heart-button';

/**
 * Mottagarsidan av ett fotosvar. Bilden och bildtexten kommer var för sig ur
 * `support_responses` och slås ihop här — se supabase/support_photo.sql för
 * varför de inte är en enda inbränd JPEG.
 *
 * Måtten på bandet kommer ur lib/photoCaption.ts och skrivs inte av här: två
 * kopior av samma tal hade inte bara glidit isär i koden utan i meddelandet —
 * avsändaren ser raden på ett ställe och mottagaren får den på ett annat.
 * `resizeMode="cover"` måste av samma skäl vara densamma på båda skärmarna.
 *
 * Handlingarna är text-message.tsx: de två tysta kanalerna ska sluta likadant,
 * för det är samma sorts pepp som landat på två sätt.
 */
export default function SupportViewPhotoScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { messageId, photoUrl, caption, captionY, senderName } =
    useLocalSearchParams<{
      messageId?: string;
      photoUrl?: string;
      caption?: string;
      captionY?: string;
      senderName?: string;
    }>();

  const [frameH, setFrameH] = useState(0);
  const [bandH, setBandH] = useState(0);

  const markDelivered = async () => {
    if (!messageId) return;
    const ts = new Date().toISOString();
    await supabase
      .from('support_responses')
      .update({ delivered_at: ts, played_at: ts })
      .eq('id', messageId);
  };

  useEffect(() => { markDelivered(); }, []);

  // Null i databasen blir en tom sträng genom ruttparametrarna. Reservvärdet är
  // samma mitt som skrivarskärmen börjar på, så en bildtext utan sparat läge
  // hamnar där den hade legat om ingen rörde den.
  const y = Number.parseFloat(captionY ?? '');
  const captionPos = Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : CAPTION_DEFAULT_Y;
  const hasCaption = !!caption?.trim();

  const handleAccept = async () => {
    await markDelivered();
    openPauseStart('replace');
  };

  const handleDecline = async () => {
    await markDelivered();
    router.replace('/(tabs)');
  };

  return (
    <View style={styles.container}>
      <View style={styles.frame} onLayout={e => setFrameH(e.nativeEvent.layout.height)}>
        {photoUrl ? (
          <Image source={{ uri: photoUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.missing]}>
            <FontAwesome5 name="image" size={32} color={Palette.ink30} />
            <Text style={styles.missingText}>The photo could not be loaded.</Text>
          </View>
        )}

        {/* Avsändaren står ovanpå bilden och inte i en list ovanför den:
            fotot ska fylla skärmen, och ett namn mot en tonad botten tar
            ingen höjd ifrån det. */}
        <View style={[styles.senderRow, { top: insets.top + 12 }]}>
          <Text style={styles.senderLabel}>SUPPORT FROM</Text>
          <Text style={styles.senderName}>{senderName ?? 'A friend'}</Text>
        </View>

        <TouchableOpacity
          onPress={handleDecline}
          style={[styles.closeBtn, { top: insets.top + 12 }]}
          activeOpacity={0.7}
          accessibilityLabel="Close"
        >
          <FontAwesome5 name="times" size={17} color="#fff" />
        </TouchableOpacity>

        {hasCaption && (
          <View
            style={[styles.captionBand, { top: captionPos * frameH - bandH / 2 }]}
            onLayout={e => setBandH(e.nativeEvent.layout.height)}
          >
            <Text style={styles.captionText}>{caption}</Text>
          </View>
        )}
      </View>

      <View style={[styles.actions, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.heartWrap}>
          <SupportHeartButton responseId={messageId} senderName={senderName ?? 'A friend'} />
        </View>
        <TouchableOpacity style={styles.acceptBtn} onPress={handleAccept} activeOpacity={0.85}>
          <FontAwesome5 name="pause" size={13} color={Palette.onAccent} />
          <Text style={styles.acceptText}>I&apos;ll take a pause</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.declineBtn} onPress={handleDecline} activeOpacity={0.8}>
          <Text style={styles.declineText}>Not a good time</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Samma undantag som support-respond-photo.tsx: det som ligger ovanpå fotot
// måste synas mot en bild vi inte känner färgen på, så de vita literalerna är
// med flit literaler. Allt under bilden är däremot paletten.
const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  frame: { flex: 1, overflow: 'hidden' },
  missing: { backgroundColor: Palette.surface, alignItems: 'center', justifyContent: 'center', gap: 12 },
  missingText: { color: Palette.textTertiary, fontSize: 14 },

  senderRow: { position: 'absolute', left: 20, gap: 2 },
  senderLabel: {
    color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '900',
    letterSpacing: 2.5, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4,
  },
  senderName: {
    color: '#fff', fontSize: 19, fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6,
  },
  closeBtn: { position: 'absolute', right: 16, padding: 12 },

  captionBand: {
    position: 'absolute', left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingVertical: CAPTION_BAND_PADDING, paddingHorizontal: 20,
  },
  captionText: {
    color: '#fff', fontSize: CAPTION_FONT_SIZE, lineHeight: CAPTION_LINE_HEIGHT,
    fontWeight: '600', textAlign: 'center',
  },

  actions: { paddingHorizontal: 24, paddingTop: 16, gap: 4, backgroundColor: Palette.bg },
  heartWrap: { marginBottom: 14 },
  acceptBtn: {
    backgroundColor: Palette.accent,
    paddingVertical: 16, borderRadius: Radius.pill,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    marginBottom: 4,
    ...Palette.cardShadow,
  },
  acceptText: { color: Palette.onAccent, fontSize: 16, fontWeight: '600', letterSpacing: 0.3 },
  declineBtn: { paddingVertical: 14, alignItems: 'center' },
  declineText: { color: Palette.textSecondary, fontSize: 15 },
});
