import { useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { IntentionSettings } from '../intention-settings';
import { IntroStep } from './intro-chrome';

/**
 * *What do you do during your pause?* — samma val som i profilen, med egna
 * intentioner (emoji + namn). Steget kom tillbaka på begäran: förr frågades
 * det före namnet och togs bort som en fråga innan man sett vad en paus är.
 * Nu står det efter namnet. Inget är förvalt, och Next kräver minst en vald
 * (på begäran) — den som kör om introduktionen ser sina sparade val.
 *
 * Varje tryck sparas direkt genom IntentionSettings (app/pauseLogger.ts),
 * inte i `finish()`: det är samma komponent som i profilen, och den har ingen
 * Spara-knapp. Ett avbrutet flöde lämnar alltså valen kvar, och det är
 * ofarligt — de är inte en del av profilen grinden läser.
 */
export function StepIntentions({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const [count, setCount] = useState(0);

  // Samma tangentbordsväg som namnsteget: fältet för en egen intention står
  // längst ner i listan och hade annars hamnat under tangentbordet på iOS.
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <IntroStep
      title={'What do you do\nduring your pause?'}
      titleSmall
      subtitle="Pick at least one."
      scroll
      primaryLabel="Next →"
      onPrimary={onNext}
      primaryDisabled={count === 0}
      onBack={onBack}
    >
      <IntentionSettings bare onSelectedChange={ids => setCount(ids.length)} />
    </IntroStep>
    </KeyboardAvoidingView>
  );
}
