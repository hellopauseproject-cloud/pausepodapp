import { router } from 'expo-router';
import type { SupportKind } from '../components/support-envelope';
import { setPending } from './supportQueue';

export type OpenableSupport = {
  id: string;
  storyId: string | null;
  kind: SupportKind;
  contentUrl: string | null;
  textContent: string | null;
  captionY: number | null;
  senderName: string;
  senderAvatarUrl: string | null;
};

/**
 * Stänger en visningsskärm: tillbaka dit man kom ifrån — kuvertraden, som
 * då visar det som är kvar, eller historiken. Förr gick text och foto till
 * Hem och röst och video till Support-fliken, oavsett var man kom ifrån, så
 * med fem svar som väntade fick man gå tillbaka och öppna kuvertet fem gånger.
 */
export function closeSupportViewer() {
  if (router.canGoBack()) router.back();
  else router.replace('/(tabs)/friends' as never);
}

/**
 * Till rätt visningsskärm för ett stödsvar. Delas av kuvertet
 * (app/support-arrived.tsx, `replace`: kuvertet ska inte gå att backa till)
 * och historiken (app/support-history.tsx, `push`), så att de två aldrig
 * öppnar samma svar på olika sätt.
 */
export function openSupportResponse(a: OpenableSupport, how: 'replace' | 'push' = 'replace') {
  const go = how === 'push' ? router.push : router.replace;
  if (a.kind === 'voice' || a.kind === 'video') {
    setPending({
      id: a.id,
      storyId: a.storyId,
      responseType: a.kind,
      contentUrl: a.contentUrl,
      textContent: a.textContent,
      senderName: a.senderName,
      senderAvatarUrl: a.senderAvatarUrl,
    });
    go(a.kind === 'video' ? '/video' : '/voice');
    return;
  }
  if (a.kind === 'photo') {
    go({
      pathname: '/support-view-photo',
      params: {
        messageId: a.id,
        photoUrl: a.contentUrl ?? '',
        caption: a.textContent ?? '',
        // Null blir en tom sträng, som visningsskärmen läser som "inget
        // sparat läge" och faller tillbaka på mitten.
        captionY: a.captionY == null ? '' : String(a.captionY),
        senderName: a.senderName,
      },
    } as any);
    return;
  }
  go({
    pathname: '/text-message',
    params: {
      messageId: a.id,
      textContent: a.textContent ?? '',
      senderName: a.senderName,
      senderAvatarUrl: a.senderAvatarUrl ?? '',
      isSupport: 'true',
    },
  } as any);
}
