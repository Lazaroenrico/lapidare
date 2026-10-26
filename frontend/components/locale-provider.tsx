"use client";
import {createContext, useContext, useEffect, useState} from 'react';
import {getSetupStatus} from '@/lib/api';
import {useEventSubscription} from './server-events';

const messages = {
  'pt-BR': {
    teachPrompt: 'O que você quer aprender ou explorar hoje?', practicePrompt: 'O que você quer praticar hoje?',
    dontKnow: 'Não sei — me ensina', confidence: 'CONFIANÇA · Grau de certeza', thinking: 'SEU RACIOCÍNIO · Por que escolheu essa opção?',
    thinkingPrompt: 'Explique sua intuição ou raciocínio em uma linha...', submit: 'Enviar resposta',
    settings: 'Configurações do Harness', setup: 'Configuração Inicial do Harness', back: 'Voltar', next: 'Avançar',
    finish: 'Concluir e abrir plataforma', save: 'Salvar', saving: 'Salvando...', close: 'Fechar',
  },
  en: {
    teachPrompt: 'What would you like to learn or explore today?', practicePrompt: 'What would you like to practice today?',
    dontKnow: "I don't know — teach me", confidence: 'CONFIDENCE · How certain are you?', thinking: 'YOUR THINKING · Why did you choose this option?',
    thinkingPrompt: 'Explain your intuition or reasoning in one line...', submit: 'Submit answer',
    settings: 'Harness settings', setup: 'Initial Harness setup', back: 'Back', next: 'Next',
    finish: 'Finish and open platform', save: 'Save', saving: 'Saving...', close: 'Close',
  },
};
type Locale = keyof typeof messages;
const LocaleContext = createContext({locale: 'pt-BR' as Locale, t: messages['pt-BR']});
export function LocaleProvider({children}: {children: React.ReactNode}) {
  const [locale, setLocale] = useState<Locale>('pt-BR');
  const [error, setError] = useState('');
  const refresh = () => getSetupStatus().then(s => setLocale(s.config?.language === 'en' ? 'en' : 'pt-BR')).catch(e => setError(e.message));
  useEffect(() => {void refresh(); const onError = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener('harness:error', onError); return () => window.removeEventListener('harness:error', onError);}, []);
  useEventSubscription('config:updated', () => {void refresh();});
  useEffect(() => {document.documentElement.lang = locale;}, [locale]);
  return <LocaleContext.Provider value={{locale, t: messages[locale]}}>
    {error && <div role="alert" className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] bg-[#1c1c1c] border border-[#434343] p-4 font-ui text-xs max-w-xl">{error}<button className="ml-4 underline" onClick={() => setError('')}>{messages[locale].close}</button></div>}
    {children}
  </LocaleContext.Provider>;
}
export const useLocale = () => useContext(LocaleContext);
