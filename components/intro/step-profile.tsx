import { FontAwesome5 } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import {
  Image, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { saveProfile } from '../../app/userProfile';
import { Radius } from '../../constants/appTheme';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { isUsernameAvailable, USERNAME_TAKEN_MESSAGE } from '../../lib/username';
import { IntroStep, useIntroStyles } from './intro-chrome';

/**
 * Namn och bild sparas lokalt här och laddas upp till Supabase först när hela
 * introduktionen är klar — samma ordning som förr. Skälet är att ett avbrutet
 * flöde inte ska lämna en halv profil i molnet: det lokala är utkastet, det
 * som skrivs i sista steget är sanningen.
 */
export function StepProfile({
  name, setName, photo, setPhoto, onNext, onBack,
}: {
  name: string;
  setName: (v: string) => void;
  photo: string | null;
  setPhoto: (v: string | null) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const { Palette, styles } = useIntroStyles();
  const { user } = useAuth();
  const [picking, setPicking] = useState(false);
  const [checking, setChecking] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const pickPhoto = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        const picked = result.assets[0].uri;
        if (Platform.OS === 'web') {
          // Ingen filkopiering på webben: `expo-file-system` har ingen
          // webbimplementation, och en blob-URL ur väljaren lever ändå så
          // länge fliken gör det. Det räcker för att hinna ladda upp den.
          setPhoto(picked);
        } else {
          // På native kopieras bilden till appens egen katalog. Väljarens
          // tillfälliga URI kan städas bort av systemet innan uppladdningen
          // sker, och då hade profilen blivit bildlös utan felmeddelande.
          const dest = FileSystem.documentDirectory + 'profilePhoto.jpg';
          await FileSystem.copyAsync({ from: picked, to: dest });
          setPhoto(dest);
        }
      }
    } catch {} finally {
      setPicking(false);
    }
  };

  /**
   * Registreringen frågar inte längre efter ett namn, så det här är stället
   * där det väljs — och därför också stället där ett upptaget namn fångas.
   * Förr kom felet först i sista steget, två skärmar bort.
   *
   * Det egna nuvarande namnet räknas som ledigt: den som kör om
   * introduktionen har redan ett, och `username_available` hade svarat att
   * det är taget (av en själv). `null` (nätet) släpper förbi, och `finish()`
   * fångar krocken som förut.
   */
  const handleNext = async () => {
    const trimmed = name.trim();
    if (!trimmed || checking) return;
    setNameError(null);
    setChecking(true);
    try {
      let own: string | null = null;
      if (user?.id) {
        const { data } = await supabase.from('profiles').select('username').eq('id', user.id).maybeSingle();
        own = data?.username ?? null;
      }
      if (own?.toLowerCase() !== trimmed.toLowerCase() && (await isUsernameAvailable(trimmed)) === false) {
        setNameError(USERNAME_TAKEN_MESSAGE);
        return;
      }
      await saveProfile(trimmed, photo);
      onNext();
    } finally {
      setChecking(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <IntroStep
        title={"Let's start with\nthe essentials"}
        subtitle=""
        primaryLabel={checking ? 'Checking…' : 'Next →'}
        onPrimary={handleNext}
        primaryDisabled={!name.trim() || checking}
        onBack={onBack}
      >
        <TouchableOpacity onPress={pickPhoto} activeOpacity={0.8}>
          {photo ? (
            <Image source={{ uri: photo }} style={[local.photo, { borderColor: Palette.accent }]} />
          ) : (
            <View
              style={[
                local.photo,
                local.photoEmpty,
                { backgroundColor: Palette.surfaceAlt, borderColor: Palette.accent },
              ]}
            >
              <FontAwesome5 name="camera" size={26} color={Palette.accent} />
              <Text style={[local.photoText, { color: Palette.accent }]}>Add photo</Text>
            </View>
          )}
        </TouchableOpacity>

        <TextInput
          style={[
            local.input,
            { backgroundColor: Palette.surfaceAlt, color: Palette.textPrimary, borderColor: Palette.accent },
          ]}
          placeholder="Username"
          placeholderTextColor={Palette.textTertiary}
          value={name}
          onChangeText={v => { setName(v); setNameError(null); }}
          autoCapitalize="words"
          returnKeyType="done"
          onSubmitEditing={Keyboard.dismiss}
          blurOnSubmit
        />
        {nameError ? (
          <Text style={[styles.hint, { color: Palette.danger }]}>{nameError}</Text>
        ) : (
          <Text style={styles.hint}>Both can be changed later.</Text>
        )}
      </IntroStep>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  photo: {
    width: 104,
    height: 104,
    borderRadius: 52,
    borderWidth: 2,
  },
  photoEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  photoText: {
    fontSize: 12,
  },
  input: {
    width: '100%',
    borderRadius: Radius.md,
    borderWidth: 2,
    paddingVertical: 15,
    paddingHorizontal: 16,
    fontSize: 17,
    textAlign: 'center',
  },
});
