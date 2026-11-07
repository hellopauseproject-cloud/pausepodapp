import { FontAwesome, FontAwesome5 } from '@expo/vector-icons';
import { decode } from 'base64-arraybuffer';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { router, useNavigation } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { AppPalette, Radius, Spacing, alpha } from '../constants/appTheme';
import { RoomProvider, usePalette } from '../contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IntentionSettings } from '../components/intention-settings';
import { roomShell, ScreenBackground } from '../components/screen-background';
import { track } from '../lib/analytics';
import { supabase } from '../lib/supabase';
import { isUsernameTakenError, USERNAME_TAKEN_MESSAGE } from '../lib/username';
import { getCachedMyProfile, setCachedMyProfile } from '../lib/myProfile';
import { saveProfile } from './userProfile';

/**
 * Hör till **study-rummet** — Pause-rummet en trappa djupare in. Se ROOMS i
 * [constants/appTheme.ts](../constants/appTheme.ts) för varför de tre
 * skärmarna bakom Hems topbar-ikoner delar ett eget, mörkare rum.
 */
export default function ProfileRoom() {
  return (
    <RoomProvider room="study">
      <View style={roomShell}>
        <ScreenBackground room="study" />
        <ProfileScreen />
      </View>
    </RoomProvider>
  );
}

function ProfileScreen() {
  const Palette = usePalette();
  const styles = useMemo(() => makeStyles(Palette), [Palette]);
  const insets = useSafeAreaInsets();
  const { signOut, user } = useAuth();
  const navigation = useNavigation();
  // Startar i det Hem redan hämtat (lib/myProfile.ts), så att namn och foto
  // står där direkt; raden läses ändå om nedan.
  const seed = user?.id ? getCachedMyProfile(user.id) : null;
  const seedPhoto = seed?.avatar_url?.startsWith('https://') ? seed.avatar_url : null;
  const [name, setName] = useState(seed?.username ?? '');
  const [photo, setPhoto] = useState<string | null>(seedPhoto);
  const [saved, setSaved] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [unsavedAction, setUnsavedAction] = useState<any>(null);

  const originalName = useRef(seed?.username ?? '');
  const originalPhoto = useRef<string | null>(seedPhoto);
  // Har användaren hunnit börja skriva innan omläsningen landat skrivs fältet
  // inte över.
  const editedRef = useRef(false);
  editedRef.current = hasChanges;

  // Primär källa: Supabase — re-fetchar när user.id ändras (logout/login som annan)
  useEffect(() => {
    if (!user?.id) {
      setName('');
      setPhoto(null);
      originalName.current = '';
      originalPhoto.current = null;
      return;
    }

    const fetchProfile = async () => {
      const { data } = await supabase
        .from('profiles')
        .select('username, avatar_url')
        .eq('id', user.id)
        .maybeSingle();

      if (data) {
        setCachedMyProfile(user.id, { username: data.username ?? '', avatar_url: data.avatar_url ?? null });
        if (editedRef.current) return;
        const n = data.username ?? '';
        // Acceptera bara HTTPS-URLer — lokala sökvägar är enhetsspecifika och delas inte
        const p = data.avatar_url?.startsWith('https://') ? data.avatar_url : null;
        setName(n);
        setPhoto(p);
        originalName.current = n;
        originalPhoto.current = p;
      }
    };

    fetchProfile();
  }, [user?.id]);

  const uploadAvatar = async (localUri: string): Promise<string | null> => {
    try {
      const base64 = await FileSystem.readAsStringAsync(localUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const path = `${user!.id}/avatar.jpg`;
      const { error } = await supabase.storage
        .from('avatars')
        .upload(path, decode(base64), { contentType: 'image/jpeg', upsert: true });
      if (error) { console.log('Avatar upload error:', error.message); return null; }
      const { data } = supabase.storage.from('avatars').getPublicUrl(path);
      return data.publicUrl + '?t=' + Date.now();
    } catch (e) {
      console.log('Avatar upload failed:', e);
      return null;
    }
  };

  const pickPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      const uri = result.assets[0].uri;
      const dest = FileSystem.documentDirectory + 'profilePhoto.jpg';
      await FileSystem.copyAsync({ from: uri, to: dest });
      setPhoto(dest);
      setHasChanges(true);
    }
  };

  const handleSave = async () => {
    if (!user?.id) return;
    setUploading(true);

    let avatarUrl: string | null = photo;

    // Om foto är en lokal fil — ladda upp till Supabase Storage och få publik URL
    if (photo && !photo.startsWith('https://')) {
      const uploaded = await uploadAvatar(photo);
      if (uploaded) {
        avatarUrl = uploaded;
        setPhoto(uploaded);
      } else {
        // Upload misslyckades — spara inte lokal sökväg, behåll ev. befintlig URL
        avatarUrl = originalPhoto.current?.startsWith('https://') ? originalPhoto.current : null;
      }
    }

    // Felet läses, och det är inte en formalitet: `profiles.username` är unikt
    // (skiftlägesokänsligt, se supabase/usernames.sql), så en omdöpning till
    // ett taget namn avvisas av databasen. Förut kastades resultatet bort och
    // koden gick vidare till "Saved!" — namnet var oförändrat i molnet, men
    // skärmen sa att det sparats och `originalName` flyttades fram, så inte
    // ens nästa jämförelse visste bättre. Ändringen var borta vid nästa
    // inläsning utan att någon fått veta varför.
    const { error: saveError } = await supabase
      .from('profiles')
      .update({ username: name.trim() || 'Unknown', avatar_url: avatarUrl })
      .eq('id', user.id);

    if (saveError) {
      track('profile_save_failed', { reason: isUsernameTakenError(saveError) ? 'username_taken' : 'other' });
      setErrorText(isUsernameTakenError(saveError) ? USERNAME_TAKEN_MESSAGE : 'Could not save. Try again.');
      setUploading(false);
      return;
    }
    setErrorText('');
    track('profile_saved', {
      name_changed: name !== originalName.current,
      has_avatar: !!avatarUrl,
    });

    // Lokal kopia för call/voice-skärmar (bakåtkompatibilitet)
    await saveProfile(name.trim() || 'Yourself', photo);
    setCachedMyProfile(user.id, { username: name.trim() || 'Unknown', avatar_url: avatarUrl });

    originalName.current = name;
    originalPhoto.current = avatarUrl;
    setUploading(false);
    setHasChanges(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      if (!hasChanges) return;
      e.preventDefault();
      setUnsavedAction(e.data.action);
    });
    return unsubscribe;
  }, [hasChanges, navigation]);

  const handleBack = () => {
    if (hasChanges) setUnsavedAction('back');
    else router.back();
  };

  const handleUnsavedDiscard = () => {
    const action = unsavedAction;
    setUnsavedAction(null);
    if (action === 'back') router.back();
    else navigation.dispatch(action);
  };

  const handleUnsavedSave = async () => {
    const action = unsavedAction;
    setUnsavedAction(null);
    await handleSave();
    if (action === 'back') router.back();
    else navigation.dispatch(action);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">

      {/* Topbar */}
      <View style={[styles.topBar, { paddingTop: Math.max(40, insets.top + 8) }]}>
        <TouchableOpacity style={styles.backButton} onPress={handleBack}>
          <FontAwesome name="chevron-left" size={16} color={Palette.accent} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.pageTitle}>My Profile</Text>

      {/* Profilbild */}
      <View style={styles.avatarSection}>
        <TouchableOpacity onPress={pickPhoto} style={styles.avatarWrapper}>
          {photo ? (
            <Image source={{ uri: photo }} style={styles.avatar} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <FontAwesome5 name="user" size={40} color={Palette.accent} />
            </View>
          )}
          <View style={styles.cameraIcon}>
            <FontAwesome5 name="camera" size={14} color={Palette.onAccent} />
          </View>
        </TouchableOpacity>

        <TextInput
          style={styles.nameInput}
          placeholder="Your name"
          placeholderTextColor={Palette.textFaint}
          value={name}
          onChangeText={t => { setName(t); setHasChanges(true); }}
          autoCapitalize="words"
        />
      </View>

      {/* Intentionerna — flyttade hit från Settings. "Show my stats" är
          borttagen: pausstatistiken syns alltid för vänner. */}
      <IntentionSettings />

      {!!errorText && <Text style={styles.saveError}>{errorText}</Text>}

      <TouchableOpacity
        style={[styles.saveButton, saved && styles.saveButtonDone]}
        onPress={handleSave}
        disabled={uploading}
      >
        <Text style={styles.saveText}>
          {uploading ? 'Uploading…' : saved ? 'Saved!' : 'Save'}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.signOutButton}
        onPress={() =>
          Alert.alert('Log out', 'Are you sure?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Log out', style: 'destructive', onPress: signOut },
          ])
        }
      >
        <FontAwesome name="sign-out" size={15} color={Palette.textFaint} />
        <Text style={styles.signOutText}>Log out</Text>
      </TouchableOpacity>

    </ScrollView>

      {/* Unsaved changes modal */}
      <Modal visible={!!unsavedAction} transparent animationType="fade" onRequestClose={() => setUnsavedAction(null)}>
        <View style={styles.unsavedOverlay}>
          <View style={styles.unsavedSheet}>
            <Text style={styles.unsavedTitle}>Unsaved changes</Text>
            <Text style={styles.unsavedBody}>Do you want to save your changes before leaving?</Text>
            <TouchableOpacity style={styles.unsavedBtnSave} onPress={handleUnsavedSave}>
              <Text style={styles.unsavedBtnSaveText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.unsavedBtnDiscard} onPress={handleUnsavedDiscard}>
              <Text style={styles.unsavedBtnDiscardText}>Leave without saving</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.unsavedBtnCancel} onPress={() => setUnsavedAction(null)}>
              <Text style={styles.unsavedBtnCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </KeyboardAvoidingView>
  );
}

const makeStyles = (Palette: AppPalette) => StyleSheet.create({
  container: {
    flexGrow: 1,
    // Botten ritas av <ScreenBackground> i skalet ovan.
    backgroundColor: 'transparent',
    padding: Spacing.xl,
    paddingTop: 0,
    paddingBottom: 60,
  },
  topBar: {
    paddingTop: 40,
    marginBottom: 16,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingRight: 16,
  },
  backText: {
    color: Palette.accent,
    fontSize: 16,
  },
  pageTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: Palette.textPrimary,
    marginBottom: 32,
  },
  avatarSection: {
    alignItems: 'center',
    marginBottom: 40,
  },
  avatarWrapper: {
    position: 'relative',
    marginBottom: 16,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
    borderColor: Palette.accent,
  },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Palette.surface,
    borderWidth: 2,
    borderColor: Palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraIcon: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: Palette.accent,
    borderRadius: 12,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameInput: {
    backgroundColor: Palette.surface,
    borderRadius: Radius.md,
    padding: 14,
    fontSize: 18,
    color: Palette.textPrimary,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
    textAlign: 'center',
    width: '80%',
  },
  nameHint: {
    fontSize: 13,
    color: Palette.textTertiary,
    marginTop: 8,
    fontStyle: 'italic',
  },
  section: {
    backgroundColor: Palette.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.surfaceBorder,
    padding: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Palette.textPrimary,
    marginBottom: 6,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: Palette.textSecondary,
    lineHeight: 20,
  },
  // Felet står ovanför knappen och inte i en Alert: det gäller namnfältet
  // längre upp på samma skärm, och ska gå att läsa medan man skriver om det.
  saveError: {
    color: Palette.danger,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
  saveButton: {
    backgroundColor: Palette.accent,
    paddingVertical: 16,
    borderRadius: Radius.pill,
    alignItems: 'center',
    marginBottom: 40,
  },
  saveButtonDone: {
    backgroundColor: Palette.success,
  },
  saveText: {
    color: Palette.onAccent,
    fontSize: 18,
    fontWeight: 'bold',
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    marginBottom: 20,
  },
  signOutText: {
    color: Palette.textTertiary,
    fontSize: 14,
  },
  statsToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  statsToggleText: {
    flex: 1,
  },
  unsavedOverlay: {
    flex: 1,
    backgroundColor: Palette.scrim,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  unsavedSheet: {
    backgroundColor: Palette.modalSurface,
    borderRadius: Radius.xl,
    padding: 28,
    width: '100%',
    gap: 12,
    borderWidth: 1,
    borderColor: Palette.modalBorder,
  },
  unsavedTitle: {
    color: Palette.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 2,
  },
  unsavedBody: {
    color: Palette.ink50,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 8,
  },
  unsavedBtnSave: {
    backgroundColor: Palette.accent,
    borderRadius: Radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  unsavedBtnSaveText: {
    color: Palette.onAccent,
    fontSize: 15,
    fontWeight: '700',
  },
  unsavedBtnDiscard: {
    backgroundColor: Palette.ink05,
    borderRadius: Radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  unsavedBtnDiscardText: {
    color: alpha(Palette.dangerSoft, 0.85),
    fontSize: 15,
    fontWeight: '500',
  },
  unsavedBtnCancel: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  unsavedBtnCancelText: {
    color: Palette.ink30,
    fontSize: 14,
  },
});
