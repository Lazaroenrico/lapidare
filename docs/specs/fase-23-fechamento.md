# Fase 23: Fechamento das Fases 19 a 22

Os invariantes do `AGENTS.md` continuam valendo. Esta fase fecha as pendências encontradas ao revisar as Fases 19 a 22 contra o plano. Nenhum contrato persistido muda de forma incompatível e `SUPPORTED_SCHEMA_VERSION` fica em 2.

## 1. Uso por turno

**Backend**
- `UsageService.session_turns(session_id)` em `services/usage.py` lê o `usage.jsonl` e devolve `{session_id, turns, background, untracked?}`:
  - **`turns`:** linhas de ensino (`turn` inteiro, sem `job_kind`) somadas por turno, `{turn, at, input_tokens, output_tokens, thinking_tokens, cached_tokens|null, calls}`. Vêm em ordem crescente, no máximo as últimas 50. `at` é o horário da primeira linha do turno.
  - **`background`:** linhas de job somadas por `job_kind`.
  - **`untracked`:** linhas antigas sem `turn` e sem `job_kind`. Só aparece quando há alguma.
- **Rota.** `GET /api/usage/sessions/{session_id}` devolve 404 quando a sessão não existe. É uma rota própria para não mudar o formato de `GET /api/usage`.
- **Jobs marcam a sessão.** `JobManager.run` passa o `session_id` do payload (quando houver) para a captura, com `charge=False`:
  - a linha do ledger fica associada à sessão;
  - o total de `SessionRecord.usage` continua contando só os turnos;
  - o `by_session` de `GET /api/usage` passa a incluir o gasto em segundo plano de cada sessão.

**Frontend**
- **Funções puras** em `lib/usage.ts`:
  - `decodeSessionTurns`;
  - `turnBars(turns, n=10)`, escalado pelo turno mais caro, que fica marcado como `peak` (o primeiro, se houver empate);
  - `bucketTotal`.
- **API.** `getSessionTurns(id)` em `lib/api.ts` devolve `null` em servidores antigos (404/405).
- **Popover.** `SessionUsageChip` recebe `sessionId`.
  - Com o popover aberto, busca os turnos e busca de novo em `usage:updated` da própria sessão, com debounce de 1 s num timer único, sem polling.
  - `TurnsSection` desenha as barras e destaca o turno mais caro. Embaixo vem "Em segundo plano", com os totais por tipo de job.
  - Strings em `meters-i18n.ts`.

## 2. Janelas de contexto

`core/model_limits.py` usa o "Input token limit" de cada página de modelo do ai.google.dev, conferido em 2026-10-28.
- **Correção:** `gemini-2.5-flash-image` passa a 65 536. O valor anterior era o limite de saída.
- **Entraram:** `gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image` e `gemini-4-argon`, que publica uma janela unificada.
- **Saíram:** as famílias desligadas (1.5 e 2.0), que não têm mais página.

## 3. Correções achadas na verificação manual

- **Medidor de contexto.** Antes, o numerador era "entrada + saída do último relatório do provedor". O `agy` soma no relatório do turno todas as chamadas internas: um turno real de diagnóstico mostrou 154k "de contexto" contra 150k de limite, com cerca de 1k tokens de histórico. Agora o `GET /api/chats/{id}` manda em `usage.context_tokens` o `history_tokens(messages, compaction)`, a mesma estimativa que a compactação compara com `compaction_tokens`. O medidor diz então exatamente quanto falta para compactar. O campo gravado em `SessionUsage` continua existindo por compatibilidade.
- **Catálogo do `agy`.** O `agy models` pode sair deixando um processo filho com o stdout aberto. Aí o `communicate()` estoura os 30 s e o `process.kill()` lança `ProcessLookupError`, e `/api/setup/models` respondia 500. Agora o processo roda em grupo próprio (`start_new_session`) e o timeout mata o grupo inteiro. O mesmo `ProcessLookupError` foi protegido no timeout do `git` (`vault/github_source.py`).
- **Código inline na prosa.** O `react-markdown` 10 não passa mais a prop `inline`, então todo `código` inline virava o bloco copiável no meio do parágrafo, com `<div>` dentro de `<p>` e erro de hidratação. Agora os blocos saem pelo `pre` (o mermaid continua ali) e o `code` é sempre inline (`components/lesson-prose.tsx`, com teste de componente).
- **Diálogos de confirmação da sidebar.** "Remover do grafo" e "Excluir" eram desenhados dentro da camada da sidebar (`z-30`), por baixo do painel flutuante do plano da aula. Com `fixed`, o `ConfirmDialog` agora vai por portal para o `body`.
- **Shift+Tab.** Quando a listagem de modelos falhava, `useCycleEffort` guardava um catálogo vazio, e o atalho ficava morto até recarregar a página. Agora só guarda um catálogo não vazio.

## 4. CI e docs

- **Release.** `desktop-release.yml` passa a ter `LEARNHARNESS_CHROMIUM=off`, como o `ci.yml`.
- **`ARCHITECTURE.md`** passa a cobrir as Fases 19 a 23: rotas, jobs, medidores, grafo, ditado, preload e updater, testes de componente e vault de exemplo.
- **`README.md` e `CONTEXT_AND_BEHAVIOR.md`:** o ditado deixa de aparecer como desativado. O README ganha a seção "Ditado (Deepgram)", com as regras de privacidade.

## 5. Pronto quando

- `make check` e `cd desktop && npm test` passam.
- A verificação manual das Fases 19 a 22 foi feita, ou ficou em roteiro para o que precisa da chave Deepgram, de microfone ou de `sudo`.
