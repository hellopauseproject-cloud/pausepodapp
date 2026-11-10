import { View } from 'react-native';

/**
 * Ett streck i veckans taggar på Hem och i kretsens intentioner: en platt,
 * helt rundad stav i en enda ton. Inget ljus, ingen kant, ingen toning — det
 * ska vara lätt att läsa och vila ögonen på bredvid ringen.
 *
 * Det var först glas i PAUSE-knappens material, och det föll på begäran.
 */
export function TallyRod({ width, height, color }: { width: number; height: number; color: string }) {
  return (
    <View style={{ width, height, borderRadius: Math.min(width, height) / 2, backgroundColor: color }} />
  );
}
