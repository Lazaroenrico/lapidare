# Fase 19: Correções rápidas

Os invariantes do `AGENTS.md` valem. Esta fase não muda nenhum contrato de backend. O catálogo de ferramentas e os goldens de turno ficam como estão.

## 1. Frontend

### 1.1 Jobs com falha voltam à bandeja

**Problema.** Desde o commit `0588e6d`, a bandeja "Agentes em segundo plano" (`components/sidebar.tsx`) mostra só jobs `queued`/`running`. Os jobs `failed`/`interrupted` sumiram da UI, e com eles o botão de tentar de novo.

**Função pura nova:** `lib/jobs-tray.ts` → `partitionTrayJobs(jobs, now, windowMs = 24h)`, que retorna `{ running, failed }`.
- **Fold por `job_id`:** fica a última ocorrência.
- **`running`:** status `queued` ou `running`, na ordem atual.
- **`failed`:** status `failed` ou `interrupted` com `updated_at` (ou `created_at`) dentro da janela. O mais recente vem primeiro. Datas ausentes ou inválidas também entram.

**Bandeja**
- A seção "Ativos" continua como hoje e passa a mostrar `job.activity` numa linha discreta (JetBrains Mono 11px, `--muted-foreground`, truncada), quando o campo existir.
- Nova seção recolhível "Falharam (N)", fechada por padrão. Cada item mostra rótulo, status, o `error` (já redigido no servidor, truncado em 2 linhas) e o botão "Tentar de novo", que reaproveita `handleRetryJob`.
- O contador do cabeçalho da bandeja continua contando só os ativos. Quando houver falhas, aparece um selo de alerta à parte.
- Strings em PT/EN.

### 1.2 Shift+Tab alterna o esforço

**Registro.** Novo atalho `{ id: "cycleEffort", combo: "Shift+Tab", scope: "global" }` em `lib/keyboard.ts`, com rótulos em `lib/settings-i18n.ts`: "Alternar esforço" / "Cycle effort".

**Captura em Settings → Teclado.** `lib/key-capture.ts` passa a aceitar Shift+Tab como combo válido. Tab sozinho continua inválido.

**Função pura:** `nextEffort(current, models)` em `lib/model-choice.ts`, onde `current = { model_id, effort }`.
- Se o modelo aceita esforço livre (`effortSelectable`), avança em `EFFORT_LEVELS` de forma circular.
- Se o id fixa o esforço pelo sufixo, avança circularmente entre as variantes da mesma família no catálogo, usando `groupModelFamilies` / `splitModelVariant`. O resultado é `{ model_id: variante, effort: null }`.
- Retorna `null` se não há o que alternar.

**Despacho**
- Novo evento `CYCLE_EFFORT_EVENT` em `lib/command-events.ts`.
- `components/global-shortcuts.tsx` liga `useShortcut("cycleEffort", …)` e dispara o evento.
- O handler retorna `false` quando nenhum alvo está registrado, para não dar `preventDefault`.
- Quem consome registra com `registerCommandTarget`, no mesmo padrão do `OPEN_MODEL_PICKER_EVENT`:
  - **Chat** (`app/chat/[id]/chat-view.tsx`): calcula com `nextEffort` sobre o slot ativo e persiste via `handleModelChange` / `updateChatSettings`.
  - **Composer da Home** (`components/composer.tsx`): altera o `choice` local, sem persistir no slot.
- Uma região `aria-live="polite"` anuncia "Esforço: alto" / "Effort: high", ou o rótulo da variante.

**Regras**
- Não roubar o Shift+Tab de dentro do model picker aberto: o focus-trap já dá `preventDefault`, e `useShortcut` ignora eventos já prevenidos. Confirmar isso.
- Não roubar dentro de diálogos modais.

**Também nesta subfase**
- **`continueTrack`:** hoje é um listener fixo de Ctrl/⌘+Enter em `composer.tsx` (cerca das linhas 170–183). Trocar por `useShortcut("continueTrack", …)`, para que remapear em Settings funcione.
- **`toggleThinking` (⌘T):** está no registro, mas não está ligado. Procure no transcript as linhas de raciocínio do aluno recolhíveis (thinking / reading-thinking).
  - Se existirem: ligue para expandir ou recolher todas, sem criar estado novo no servidor, só estado local da view.
  - Se não existirem: remova do registro, dos rótulos e da tabela de atalhos.
  - Diga no relatório qual foi o caso.

### 1.3 Decoder de PDF

**Problema.** Em `lib/job-steer.ts`, a decodificação de páginas do PDF usa `pages ?? pages_cited ?? pages_read`. Um `pages_cited: []` vazio esconde `pages_read`.

**Correção.** Usar o primeiro array **não vazio**, na mesma ordem.

### 1.4 Testes (node --test, `tests/*.test.cjs`)

- `tests/jobs-tray.test.cjs` (novo):
  - fold por `job_id`;
  - janela de 24 h;
  - ordenação;
  - `interrupted` conta como falha;
  - um retry que volta a `running` sai de `failed`.
- `tests/keyboard.test.cjs`: `cycleEffort` existe, sem conflito com os padrões; captura aceita Shift+Tab e rejeita Tab sozinho.
- `tests/model-picker.test.cjs` (ou um arquivo novo): `nextEffort` com esforço livre (low → medium → high → low), variantes fixas e caso `null`.
- `tests/job-steer.test.cjs` (existente ou novo): `pages_cited: []` com `pages_read: [2,3]` resulta em `[2,3]`.

## 2. Docs, CI e limpeza

### 2.1 Docs desatualizadas

**`docs/ARCHITECTURE.md`**
- Linha da Fase 15 na tabela de fases: implementada.
- Seção de `make check`: `check-backend` inclui `basedpyright`; `check-frontend` inclui `npm run lint`.
- Contagens de testes: use os números reais. Conte de novo com `uv run pytest --collect-only -q | tail -1` e contando os `test(` no frontend.
- Confiança: slider livre de 0 a 100 (passo 5 no teclado), sem paradas `[0,30,50,70,90,100]`.
- §13.2 e §13.4: o ditado aparece como "desativado temporariamente (volta na Fase 22)".

**`docs/CONTEXT_AND_BEHAVIOR.md`**
- §1.1: paleta `#1a1430` (roxa), não grafite `#141414`. O ditado está desativado por enquanto.
- §3.4: ditado.
- §3.6: as "Baterias de Problem Sets (LangGraph)" foram substituídas na Fase 9 por sessões PRACTICE com `problem`/`conclude`. Ajustar também o mermaid.

**`README.md`:** mesma correção do ditado e o bloco de testes com basedpyright e lint.

**Estilo:** não reescreva seções inteiras; corrija só o que está desatualizado, no tom do documento.

### 2.2 Remover `VaultPort`

`VaultPort` em `backend/src/learnharness/core/ports.py` é legado e não tem usuários.
- Remova a classe e a exportação em `core/__init__.py`.
- Ajuste `ARCHITECTURE.md` onde ele é citado.
- Se o baseline do basedpyright (`backend/.basedpyright/baseline.json`) referenciar erros dele, regenere ou ajuste o baseline.

### 2.3 CI em push/PR

Novo `.github/workflows/ci.yml`:
- `on: push` (branches `main`) e `pull_request`;
- job em `ubuntu-22.04`;
- setup de uv e node, nas mesmas versões e com o mesmo cache de `desktop-release.yml`; reaproveite os passos que ele já usa;
- passos: `make check` e `cd desktop && npm ci && npm test`;
- sem build de pacotes;
- `concurrency` que cancela execuções antigas da mesma ref.

## 3. Pronto quando

- `make check` passa.
- `cd desktop && npm test` passa.
- Com `make dev`: um job de pesquisa que falha (engine indisponível) aparece em "Falharam" e "Tentar de novo" o recoloca em execução.
- Shift+Tab no composer da Home e no chat muda o esforço; no chat, a escolha persiste após recarregar a página.
