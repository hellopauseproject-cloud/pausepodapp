import { StyleSheet, Text, View } from 'react-native';

import { usePalette } from '../contexts/ThemeContext';

// Samma märke som joinpausepod.com: två rundade streck och ordet i
// displayvikt. Måtten är webbens (`.pause i` 0.4 × 1.15rem, glapp 0.22rem,
// texten 0.9rem med 0.24em spärrning) räknade mot textens storlek, så att
// märket behåller formen i alla storlekar.
//
// Strecken och ordet bär rummets kulör (`hue`), för det är logotypen som
// säger vilket rum man står i. (På webben står ordet i bläck; i appen fick det
// strecken färg på begäran.)
//
// `section` skriver flikens namn efter märket — `PAUSEPOD | CIRCLES` — i
// samma versaler och storlek men tunn vikt, så att märket fortfarande är det
// tunga och namnet läses som en rubrik under det. Strecket mellan är svagare.
export function PausePodLogo({
  size = 14,
  color,
  textColor,
  section,
}: {
  size?: number;
  color?: string;
  textColor?: string;
  section?: string;
}) {
  const Palette = usePalette();
  const unit = size / 0.9;
  const barColor = color ?? Palette.hue;

  return (
    <View
      style={[styles.row, { gap: unit * 0.7 }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={section ? `PausePod, ${section}` : 'PausePod'}
    >
      <View style={[styles.row, { gap: unit * 0.22 }]}>
        {[0, 1].map(i => (
          <View
            key={i}
            style={{
              width: unit * 0.4,
              height: unit * 1.15,
              borderRadius: unit,
              backgroundColor: barColor,
            }}
          />
        ))}
      </View>
      <Text
        style={[
          styles.word,
          {
            fontSize: size,
            lineHeight: Math.round(size * 1.15),
            letterSpacing: size * 0.24,
            color: textColor ?? barColor,
          },
        ]}
      >
        PAUSEPOD
      </Text>
      {section && (
        <Text
          style={[
            styles.section,
            {
              fontSize: size,
              lineHeight: Math.round(size * 1.15),
              letterSpacing: size * 0.24,
              color: textColor ?? barColor,
              marginLeft: -unit * 0.3,
            },
          ]}
        >
          <Text style={{ opacity: 0.45 }}>|</Text>
          {'  '}
          {section.toUpperCase()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  word: { fontWeight: '900' },
  section: { fontWeight: '300' },
});
