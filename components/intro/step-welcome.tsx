import { FontAwesome } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { IntroStep, useIntroStyles } from './intro-chrome';

/**
 * Hälsningen. Utgången (*Set up later*) står inte här utan uppe till höger i
 * skalet, [app/intro.tsx](../../app/intro.tsx), och bara medan den här sidan
 * visas — se kommentaren där.
 */
export function StepWelcome({ onNext }: { onNext: () => void }) {
  const { Palette } = useIntroStyles();
  const fade = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.85)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 6, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <IntroStep
      title={'Welcome to\nPausePod'}
      subtitle="Two short steps."
      primaryLabel="Get started →"
      onPrimary={onNext}
    >
      <Animated.View style={{ opacity: fade, transform: [{ scale }] }}>
        <View style={[local.mark, { backgroundColor: Palette.accentTint, borderColor: Palette.accentBorder }]}>
          <FontAwesome name="pause" size={40} color={Palette.accent} />
        </View>
      </Animated.View>
    </IntroStep>
  );
}

const local = StyleSheet.create({
  mark: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
