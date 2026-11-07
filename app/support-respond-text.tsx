import { FontAwesome5 } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import DismissKeyboardView from './components/DismissKeyboardView';
import { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView, Platform, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { OpensPicker, SealedSendOverlay, SEALED_SEND_MS } from '../components/opens-picker';
import { useAuth } from '../contexts/AuthContext';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { AppPalette, Radius, alpha } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { roomShell, ScreenBackground } from '../components/screen-background';

/**
 * Hör till **friends-rummet**. Rummet följer ärendet och inte filträdet — se
 * ROOMS i [constants/appTheme.ts](../constants/appTheme.ts). Skalet är
 * identiskt med de andra rummens: en komponent kan inte läsa sin egen
 * provider, och en bakgrund i skalet täcker varje gren skärmen returnerar.
 */
export default function SupportRespondTextRoom() {
  return (
    <RoomProvider room="friends">
      <View style={roomShell}>
        <ScreenBackground room="friends" />
        <SupportRespondTextScreen />
      </View>
    </RoomProvider>
  );
}

function SupportRespondTextScreen() {
  const Palette = usePalette();
  const s = useMemo(() => makeS(Palette), [Palette]);
  const { user } = useAuth();
  const { storyId, ownerName } = useLocalSearchParams<{ storyId: string; ownerName: string }>();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sealed, setSealed] = useState(false);

  const handleSend = async () => {
    if (!user || !text.trim() || sending || !storyId) return;
    setSending(true);
    const { error } = await supabase.from('support_responses').insert({
      story_id: storyId,
      sender_id: user.id,
      response_type: 'text',
      text_content: text.trim(),
      // Försluten tills mottagaren gjort en paus (supabase/support_sealed.sql).
      // Bara när den är vald, så att *Now* fungerar mot en databas utan kolumnen.
      ...(sealed ? { opens_after_pause: true } : {}),
    });
    if (!error) {
      // Längden, inte texten: ett stödsvar är det mest privata appen bär,
      // och händelseloggen behöver bara veta att det skickades.
      track('support_response_sent', { response_type: 'text', length: text.trim().length, sealed });
      setSent(true);
      setTimeout(() => router.back(), sealed ? SEALED_SEND_MS : 900);
    } else {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <DismissKeyboardView style={s.root}>
      <View style={s.container}>
        <View style={s.handle} />

        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.closeBtn} activeOpacity={0.7}>
            <FontAwesome5 name="times" size={15} color={Palette.ink40} />
          </TouchableOpacity>
          <Text style={s.title}>Reply to {ownerName}</Text>
          <View style={{ width: 40 }} />
        </View>


        <TextInput
          style={s.input}
          value={text}
          onChangeText={t => { if (t.length <= 300) setText(t); }}
          placeholder={`Write a few words of support to ${ownerName}…`}
          placeholderTextColor={Palette.ink20}
          multiline
          maxLength={300}
          autoFocus
          editable={!sent}
        />
        <Text style={s.charCount}>{300 - text.length}</Text>

        <OpensPicker sealed={sealed} onChange={setSealed} ownerName={ownerName ?? ''} />

        <TouchableOpacity
          style={[s.sendBtn, (!text.trim() || sending || sent) && s.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!text.trim() || sending || sent}
          activeOpacity={0.85}
        >
          <FontAwesome5 name={sent ? 'check' : 'paper-plane'} size={14} color={Palette.onAccent} />
          <Text style={s.sendBtnText}>
            {sent ? 'Sent!' : sending ? 'Sending…' : 'Send'}
          </Text>
        </TouchableOpacity>
      </View>
      {sent && sealed && <SealedSendOverlay />}
      </DismissKeyboardView>
    </KeyboardAvoidingView>
  );
}

const makeS = (Palette: AppPalette) => StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', backgroundColor: Palette.scrim },
  container: {
    backgroundColor: Palette.surfaceAlt, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    padding: 24, paddingBottom: 48, gap: 16,
    borderTopWidth: 1, borderColor: Palette.surfaceBorder,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: Palette.ink15, alignSelf: 'center', marginBottom: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'flex-start' },
  title: { fontSize: 17, fontWeight: '700', color: Palette.textPrimary, letterSpacing: 0.2 },
  input: {
    backgroundColor: Palette.surface, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Palette.surfaceBorder,
    padding: 16, color: Palette.textPrimary, fontSize: 15,
    minHeight: 120, textAlignVertical: 'top', lineHeight: 22,
  },
  charCount: { color: Palette.textDisabled, fontSize: 12, textAlign: 'right' },
  sendBtn: {
    backgroundColor: Palette.community, paddingVertical: 14, borderRadius: 32,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  sendBtnDisabled: { backgroundColor: alpha(Palette.community, 0.2) },
  sendBtnText: { color: Palette.onAccent, fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },
});
