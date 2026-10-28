# Fase 21: Grafo e medidores

Os invariantes do `AGENTS.md` continuam valendo:
- `core/` puro;
- um único SSE, no padrão notify → fetch;
- nenhum `setInterval`;
- tokens de design;
- toda string em PT/EN.

**Campos novos.** Todo campo novo em contratos persistidos (`config.json`, `sessions/*.jsonl`, `usage.jsonl`) é opcional e tem default. Antes de criar, confira o `model_config` (`extra`) dos modelos afetados e `core/schema_gate.py`. Se um build anterior quebrar ao ler o campo novo, suba `SUPPORTED_SCHEMA_VERSION` junto com `HarnessConfig.schema_version`. Se não quebrar, não suba, e diga no relatório qual foi o caso.

## 1. Anel de cobertura da extração

### 1.1 Backend

Crie `GraphService.coverage_for(session) -> SessionCoverage | None` em `services/graph.py`. Para sessões PRACTICE, devolve `None`.

`SessionCoverage` é um contrato novo em `core/contracts/graph.py`:

| Campo | Valor |
|---|---|
| `uncovered_tokens: int` | `sum(m.tokens for m in self._uncovered(session))`, a mesma conta que `maybe_extract` usa |
| `chunk_tokens: int` | `config.graph.extraction_chunk_tokens` |
| `extracting: bool` | `True` se há um job `extraction` em `queued` ou `running` cujo `payload.session_id` é o da sessão. Use `state.active_jobs` |
| `enabled: bool` | `config.graph.extraction_enabled` (seção 3) |

`GET /api/chats/{id}` passa a incluir `coverage` nesse formato, ou `null`. O cálculo é barato, então não precisa de cache além do que já existe. Se medir e o custo for relevante, cacheie por (`session.updated_at`, tamanho de `coverage.jsonl`).

### 1.2 Frontend

**Lógica pura.** Crie `lib/coverage-ring.ts` com `ringState(cov)`, que devolve `{ visible, fraction, pulsing, tooltip }`:

| Campo | Regra |
|---|---|
| `visible` | `cov != null && cov.enabled` |
| `fraction` | `min(1, uncovered / chunk)` |
| `pulsing` | `extracting` |
| `tooltip` | "N de M tokens até a próxima extração" ou, com `extracting`, "Extraindo para o grafo…" (EN equivalente) |

**Componente.** Crie `components/extraction-ring.tsx`: um anel SVG de cerca de 16px, com trilho em `--border` e arco em `--foreground`. A pulsação usa uma animação CSS em `globals.css` que respeita `prefers-reduced-motion`.
- Fica no header do chat (`app/chat/[id]/chat-view.tsx`) **no lugar do** botão de texto "Extrair para o grafo".
- Clicar chama o `handleExtract` existente e mantém o `extractNotice` atual.
- `aria-label` igual ao tooltip.

O anel atualiza com o refetch que o chat já faz em `session:updated`, `jobs:updated` e `graph:updated`. Não crie polling.

## 2. Medidor de contexto e detalhe de uso

### 2.1 Backend

**`SessionUsage`** (`core/contracts/session.py`) ganha:
- `context_tokens: int | None = None`: input + output do **último** report de uso recebido na sessão;
- `last_turn: TokenUsage | None = None`: soma dos reports do último turno.

**Gravação.** Os dois são gravados onde a sessão acumula uso hoje (`services/usage.py` / `services/sessions.py`).
- Defina "turno" pelo contador de execuções da sessão. Procure o que já existe (`execution` ou equivalente). Se não houver nada, crie `SessionRecord.turn_seq: int = 0`, incrementado a cada execução.
- Uma compactação concluída volta `context_tokens` para `None`.

**Ledger.** As linhas de `usage.jsonl` ganham `turn: int | None` e `cached_tokens: int | None`.
- `cached_tokens` é preenchido onde o engine informar (genai: `cached_content_token_count`; agy: se `result.usage` tiver o dado).
- Atualize os adaptadores em `engines/usage.py` sem quebrar os demais.

**Janela do modelo.** Crie `core/model_limits.py`, puro, com `context_window(model_id) -> int | None`: uma tabela por prefixo de família Gemini, com o valor publicado de cada família conhecida e `None` para as demais (ausente não é zero).
- O catálogo de `engines/models.py` passa a devolver `context_window` por modelo.
- No engine genai, use `input_token_limit` do SDK quando disponível; caso contrário, a tabela.

**API.** `GET /api/chats/{id}` inclui em `usage`:

| Campo | Valor |
|---|---|
| `context_tokens` | o valor gravado, ou `null` |
| `context_limit` | `min(compaction_tokens, janela - 16000)` quando a janela é conhecida, senão `compaction_tokens` |
| `limit_kind` | `"compaction"` ou `"window"`, conforme qual valor venceu |
| `last_turn` | o valor gravado |

### 2.2 Frontend

**Popover.** O chip de uso do header do chat (`chat-view.tsx`) vira gatilho de um popover. Siga os padrões de popover que já existem, por exemplo o model picker ou os menus da sidebar. O conteúdo:
- **Barra de contexto:** "42k / 150k até compactar", ou "até o limite do modelo" quando `limit_kind` é `window`. Com `context_tokens` nulo, mostra "?".
- **Último turno:** entrada, saída, raciocínio e cache, este só quando houver.
- **Total da sessão.**

**Formatação.** Fica em `lib/usage.ts`, em funções puras testadas.

## 3. Toggles do grafo e Home mínima

### 3.1 Backend

**Novo campo.** `GraphSettings.extraction_enabled: bool = True` (`core/contracts/config.py`). Exponha no mesmo `GET/PUT` que já expõe `extraction_chunk_tokens` (veja `api/routes/settings_agent.py` e `frontend/lib/settings-wire.ts`).

**Comportamento com `False`:**
- `maybe_extract` não faz nada.
- `POST /api/graph/extract/{id}` devolve 409 com a mensagem "a extração para o grafo está desligada nas configurações".
- O import de notas (`graph_notes`) continua funcionando, porque é uma ação explícita do usuário.

### 3.2 Frontend

**Settings.** Em Settings → Grafo, um switch "Extrair automaticamente para o grafo" ligado a `extraction_enabled`, e um switch "Mostrar o grafo na Home" ligado a `rendering` (padrão `true`). Mexer em `rendering` exige:
- adicionar o campo em `lib/graph-settings.ts`, que vai para o localStorage como as demais opções de exibição;
- sanitizar o valor;
- manter a chave de storage ou migrar sem perder as outras opções.

**Home mínima.** Novo `components/minimal-home.tsx`, que `app/page.tsx` usa no lugar de `GraphView` quando `rendering === false`. Mostra:
- uma linha de contagens com nós, cadeias, sessões e fontes, tiradas do mesmo snapshot do grafo que a Home já busca (reaproveite o fetch e o refetch em `graph:updated`);
- os botões ☍ Chains e ↑ Import, com os mesmos handlers da Home com grafo;
- o usage pill.

Composer, chip da trilha e estado vazio continuam valendo. O estilo é discreto: JetBrains Mono para números e rótulos, centralizado.

## 4. Remover rastros do grafo sem apagar a sessão

### 4.1 Backend

`POST /api/chats/{id}/graph/unlink` chama `GraphService.unlink_session(session_id)` (`services/graph.py`).
- Em seguida grava em `coverage.jsonl` a linha `{session_id, reset: true}`. `load_coverage` já entende o reset, e com ele a sessão volta a contar como não coberta e pode ser re-extraída. Adicione em `vault/graph_store.py` um helper para gravar essa linha, se não existir.
- Devolve 409 se houver turno rodando na sessão ou extração em `queued`/`running` para ela, e 404 se a sessão não existe.
- Faz broadcast de `graph:updated` e `session:updated`, como os outros caminhos de unlink.

### 4.2 Frontend

- `api.ts`: `unlinkChatFromGraph(id)`.
- Menu ⋯ da sessão na sidebar: item "Remover do grafo" (só em TEACH). Abre o `ConfirmDialog` existente com o texto "Os nós que só vieram desta sessão saem do grafo. A sessão continua, e pode ser extraída de novo." (EN equivalente).
- Erros 409 aparecem como os demais erros do menu.

## 5. Clusters

Nada a construir aqui. Confira que, em `components/graph-canvas.ts`, os rótulos dos nós e os rótulos de cluster fazem crossfade (um aparece enquanto o outro some) em torno de `labelZoom`. Se existir uma faixa de zoom em que os dois ficam ilegíveis ao mesmo tempo, ajuste as curvas de opacidade e explique no relatório. Se não existir, não mexa.

## 6. Testes

**Backend (pytest):**
- `coverage_for`: sem extração, com extração em fila, com `enabled=False` e com PRACTICE.
- `context_tokens` e `last_turn` gravados, e `context_tokens` voltando a `None` após a compactação.
- `context_window` e o `context_limit` resultante, nos dois `limit_kind`.
- `extraction_enabled=False` bloqueando o gatilho automático e o manual (409).
- unlink: nós saem, cobertura reseta e `maybe_extract` volta a ver tokens não cobertos; 409 e 404.
- Linhas antigas de `usage.jsonl` sem os campos novos continuam sendo lidas.

**Frontend (node --test):**
- `ringState`;
- a formatação do popover de uso;
- a sanitização de `graph-settings` com `rendering`.

## 7. Pronto quando

`make check` e `cd desktop && npm test` passam.
