# Fase 13: Configurações e atalhos

Os invariantes do `AGENTS.md` valem.

A base já existe:
- `config.agent` (`tools.research/pdf/visual/demo`, `compaction_tokens`) e `config.graph.extraction_chunk_tokens`;
- as rotas `GET`/`PUT`/`DELETE /api/settings/prompts…` (Fase 8);
- `lib/keyboard.ts` (registro, `comboFor`, `sanitizeKeymap`, `saveKeymap`, `conflicts`, `formatCombo`, `KEYMAP_CHANGED_EVENT`).

## 1. Backend

- `GET /api/settings/agent` → `{tools: {research, pdf, visual, demo}, compaction_tokens, extraction_chunk_tokens}`.
- `PUT /api/settings/agent` com o mesmo corpo, parcial. Valida e salva no `config.json`, depois emite `config:updated` (adicionar ao enum do backend se faltar; o frontend já escuta).
- **Aplicação dos toggles nas ferramentas:** se a Fase 10 já tiver posto a recusa nas ferramentas, não duplicar. Se não, garantir pelo menos que `spawn_demo` recuse quando `tools.demo == False`, com texto corretivo.
- **Testes:** validação (mínimo de 32k na compactação, mínimo de 500 nos chunks), persistência e evento.

## 2. Frontend: a página `/settings` vira uma tela com navegação lateral

As seções existentes (conectores, slots, permissão do agy, MCP etc.) continuam, reorganizadas. Seções:

1. **Conectores:** o conteúdo atual (slots, teste, permissão do agy).
2. **Agente:**
   - toggles das ferramentas (Pesquisa, PDF, Visual, Demo) com descrição de uma linha;
   - limiar de compactação (slider ou número, mínimo 32k);
   - tamanho do lote de extração do grafo.
   - **Prompts do sistema:** lista agrupada (Compartilhados / Diagnóstico / Professor / Prática / Handoff), de `GET /api/settings/prompts`. Cada segmento tem:
     - o texto original (somente leitura, recolhível);
     - um editor de override (textarea monoespaçada) com Salvar (`PUT` `{text, enabled}`) e Restaurar (`DELETE`);
     - um interruptor ligado/desligado;
     - um aviso "editar prompts muda o comportamento do professor".
3. **Grafo:** ajustes de exibição e física (os mesmos da engrenagem; reutilizar `lib/graph-settings.ts` e o mesmo `localStorage`) e "Restaurar padrão".
4. **Aparência:** tamanho da prosa (14–20 px, padrão 16) e títulos em serifa ligados/desligados, em `localStorage` (`learnharness:appearance`). Aplicados por variáveis CSS no `:root`, mantendo os tokens. Tema escuro apenas.
5. **Teclado:**
   - tabela de atalhos do registro com rótulo i18n, escopo e combo atual formatado;
   - "Redefinir": captura a próxima combinação de teclas, Esc cancela;
   - "Restaurar padrão" por linha e geral;
   - aviso de conflito com `conflicts()`;
   - salva com `saveKeymap` e dispara `KEYMAP_CHANGED_EVENT`.
6. **Geral:** idioma (`PT-BR`/`EN`, que já existe no setup) e caminho do vault (somente leitura, com um botão para o Setup).

**Atalhos globais:**
- `help` (`?`): folha de atalhos em modal, listando o registro com os combos efetivos;
- `settings` (⌘,): abre `/settings`;
- `modelPicker` (⌘K): abre o seletor de modelo do composer ou da sessão, se a Fase 8B expuser um evento; senão, despachar `window` `CustomEvent("learnharness:open-model-picker")` e fazer o `model-picker` escutar;
- `dictate` (⌘D): alterna o ditado no campo ativo, pelo evento `learnharness:toggle-dictation` que o `use-dictation` passa a escutar.

**Navegação:** um link para Configurações na sidebar, com o atalho visível.

Tudo com tokens, i18n PT-BR/EN e `localStorage` em try/catch.

## 3. Testes

Lógica pura em `lib/` com testes: aparência (clamp/parse), agrupamento de prompts por caminho, modelo de captura de combo a partir de um `KeyLike`. Mais `tsc`, `npm test` e `build`.
