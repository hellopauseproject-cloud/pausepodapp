import { supabase } from './supabase';

const SUPABASE_URL = 'https://iwyumzgewiwvcbuqzjnk.supabase.co';
const BUCKET = 'support-media';

/**
 * Laddar upp en lokal fil (`file://…`) till `support-media` och returnerar den
 * publika URL:en. Rösten, videon och fotot delar den här — tre kopior av
 * samma trettio rader hade glidit isär, och det är just en sådan kopia som
 * bar bucket-namnet och URL:en på var sitt ställe. Samma skäl som
 * `duration-wheel.tsx` och `intro-chrome.tsx` finns för.
 *
 * XHR + FormData och inte `supabase.storage.upload()`: klienten vill ha en
 * Blob eller en ArrayBuffer, och React Natives `fetch` mot en `file://`-URI
 * ger en tom sådan på Android. FormData med `{ uri }` är den väg RN:s
 * nätverkslager självt kan läsa filen från disk.
 */
export async function uploadSupportMedia(
  localUri: string,
  storagePath: string,
  mimeType: string,
): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not logged in');

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-upsert', 'true');
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    const form = new FormData();
    form.append('', { uri: localUri, type: mimeType, name: storagePath.split('/').pop() ?? 'file' } as any);
    xhr.send(form);
  });

  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}

/** Hur länge en signerad länk gäller. Skärmarna hämtar nya vid varje fokus. */
const SIGNED_URL_TTL_S = 6 * 60 * 60;
const PUBLIC_PREFIX = `/storage/v1/object/public/${BUCKET}/`;

/**
 * Byter `content_url` mot signerade länkar. Raderna bär fortfarande den
 * publika URL:en som `uploadSupportMedia` returnerar, men bucketen ska vara
 * privat (supabase/security_hardening.sql): bara avsändaren och mottagaren får
 * läsa filen, och det avgörs av storage-policyn när länken signeras.
 *
 * Faller signeringen används den gamla URL:en — samma beteende som förut så
 * länge bucketen är publik, och aldrig ett fel som fäller skärmen.
 */
export async function signSupportMediaUrls(urls: (string | null)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const paths = new Map<string, string>();
  for (const url of urls) {
    if (!url) continue;
    out.set(url, url);
    const at = url.indexOf(PUBLIC_PREFIX);
    if (at >= 0) paths.set(decodeURIComponent(url.slice(at + PUBLIC_PREFIX.length)), url);
  }
  if (paths.size === 0) return out;
  try {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls([...paths.keys()], SIGNED_URL_TTL_S);
    for (const row of data ?? []) {
      const original = row.path ? paths.get(row.path) : undefined;
      if (original && row.signedUrl && !row.error) out.set(original, row.signedUrl);
    }
  } catch {
    // Den publika URL:en står kvar.
  }
  return out;
}
