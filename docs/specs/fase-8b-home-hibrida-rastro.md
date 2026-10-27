# Fase 8B: Home híbrida + rastro de conhecimento

**Fonte da verdade** para esta fase. Os invariantes do `AGENTS.md` valem integralmente.

**Decisão do usuário (2026-10-27):** o produto passa a ser um misto do upstream com o nosso:
- **o grafo é a base** para todo mundo e é alimentado por qualquer sessão TEACH;
- **a trilha é uma camada opcional** por cima.

**Licença:** reescrita própria (sem copiar código ou texto do upstream AGPL). A referência de comportamento é `components/home.tsx`, `graph-view.tsx` e `src/agent/subagents/extraction.ts` do upstream.

## 1. Comportamento

1. **Home = grafo em tela cheia, sempre.**
   - Por cima do grafo:
     - topo: buscar nós, `☍ Chains`, `↑ Import`, `⇶ Roteiro` (só com trilha) e a engrenagem;
     - canto: o indicador de uso.
   - Embaixo, o dock do composer: `TEACH | PRACTICE`, a área de texto e enviar, a barra larga **"Ditar"**, o seletor de **modelo** e o seletor de **esforço**.
   - O chip da trilha ativa aparece acima do composer só quando existe trilha.
2. **Rastro contínuo.**
   - Toda sessão TEACH alimenta o grafo enquanto acontece, não só quando um nó é dominado.
   - Cada **proposição** é uma afirmação verdadeira e autocontida com nome curto. Cada **cadeia** liga premissas que, juntas, implicam uma conclusão.
   - Cada sessão é um **cluster** (região colorida com rótulo = título da sessão).
3. **Sem trilha** (modo livre, que é o padrão):
   - o aluno digita o que quer aprender;
   - ou seleciona nós no grafo e clica **"Ensinar a partir daqui"** / **"Praticar estes"**. A sessão nova recebe essas proposições e cadeias como contexto ("já sabido; não reensinar" ou "material de prática").
4. **Com trilha:**
   - o chip "⇶ Trilha · Próximo…" continua;
   - o toggle **⇶ Roteiro** mostra os itens da fila ainda não concluídos como **nós fantasmas** (vazados, tracejados), ligados aos nós reais nascidos nas sessões daquele item.
5. **Nó clicado:** cartão com nome, afirmação e sessões de origem. Cada sessão é um link para `/chat/<id>#message-<msgId>`, que rola e pisca a mensagem. Há também "Abrir nota" (a nota em `Conceitos/`) e "Excluir" (com confirmação).
6. **Vault.** Cada proposição é espelhada em uma nota curta `Conceitos/<Nome>.md`:
   - frontmatter `harness_id`, `aliases`, `sessions`;
   - seção gerenciada com a afirmação, as premissas (`[[...]]`) e a origem (`[[Aulas/...]]`).
   - **Merge não destrutivo:** o texto livre do usuário fora da seção gerenciada é preservado.
   - Se uma nota `Conceitos/X.md` já existir sem `harness_id`, ela é **adotada** (ganha a seção gerenciada), nunca sobrescrita.
   - O grafo do Obsidian passa a mostrar o mesmo rastro.
7. **Setup.** A trilha é opcional e o padrão é "Livre". Dá para ligar uma trilha depois em Configurações.

## 2. Backend: armazenamento e contratos (`core/contracts/graph.py`)

O armazenamento fica em `.harness/graph/` e é *append-only*.

**`nodes.jsonl`:**
- A linha de criação traz `{id: "n_<12hex>", name, statement, aliases: [], created_at, provenance: [{session_id, message_id}], vault_rel_path}`.
- As linhas seguintes do mesmo id são *link-appends* `{id, aliases?, provenance?}`, unidos na leitura.
- `{id, deleted: true}` é tombstone.

**`chains.jsonl`:**
- `{id: "arg_<12hex>", premises: [node_id], conclusion: node_id, provenance: [...], created_at}`.
- Tombstone igual ao de `nodes.jsonl`.
- Na leitura, cadeias com o mesmo `(premises ordenadas, conclusion)` se fundem.

**`coverage.jsonl`:**
- `{session_id, message_id, fp: sha256(conteúdo), tokens: len/4, at}`.
- Uma mensagem está coberta se `fp` bate. Só conta prosa do professor (`role == "assistant"`).

**`positions.json`:** posições arrastadas pelo usuário `{node_id: {x, y}}`. Não é append-only.

**Snapshot (`GET /api/graph`)**, compatível com o frontend atual e com o legado:
- `nodes[]`: `{id, name, title (=name), statement, summary (=statement), aliases, cluster (=session_id de nascimento), sessions: [{session_id, title, message_id}], vault_rel_path, x?, y?, ghost: false}`;
- `chains[]`: `{id, premises, conclusion, expression ("A ∧ B ⟹ C" com nomes), created_at, session_id}`;
- `edges[]` derivadas: premissa → conclusão, `kind: "chain"`;
- `clusters[]`: `{id, label, kind: "session" | "notes" | "legacy", size}`;
- `roadmap[]` (só com trilha): `{id: "track:<item_id>", title, status, linked_node_ids: [...], depends_on: [track ids]}`;
- `updated_at`.

**Legado:** notas `Conceitos/*.md` antigas, sem `harness_id` e não adotadas, continuam aparecendo como nós (`cluster: "legacy"`) via `scan_all_concepts`, para que vaults já existentes não percam o grafo.

## 3. Backend: pipeline de extração contínua

**Gatilho:**
- ao fim de cada execução de sessão TEACH, se `tokens não cobertos ≥ config.graph.extraction_chunk_tokens` (padrão 4096);
- e sempre ao concluir a sessão.
- Manual: `POST /api/graph/extract/{session_id}`.
- É um job `extraction` em BACKGROUND AGENTS, com chave por sessão, para não duplicar.
- O gatilho antigo no `plan_advance(mastered)` passa a ser só um caso do gatilho geral.

**Lote:** mensagens não cobertas mais antigas, gulosamente até o orçamento. Cada mensagem vai rotulada `TEACHER [<message_id>]`.

**Extrator** (`run_structured`, slot `background`):
- Devolve `{propositions: [{key: "p1", name, statement, aliases, message_id}], chains: [{premises: [key | n_id], conclusion: key | n_id}]}`.
- O prompt mostra "o grafo até agora" desta sessão (ids, nomes e afirmações), para reaproveitar ids existentes.
- Só verdades sobre o mundo. Nunca o estado do aluno. Concepção errada entra como a sua correção.
- Cadeias só por implicação.

**Auditor:**
- Para cada proposição nova, busca candidatas equivalentes no grafo inteiro: pré-filtro barato por sobreposição de tokens do nome e da afirmação (top 8).
- Pergunta ao modelo em uma chamada estruturada: `{links: [{key, link_to: n_id | null}]}`.
- Tem viés de equivalência: paráfrase funde.

**Merger** (determinístico, puro em `core/graph_merge.py`):
- resolve as keys;
- grava nós novos e link-appends;
- grava as cadeias, descartando as redundantes (mesmas premissas e conclusão; premissas que são superconjunto de uma cadeia existente para a mesma conclusão);
- grava a cobertura;
- escreve ou atualiza as notas `Conceitos/`;
- emite `GRAPH_UPDATED` e `VAULT_CHANGED`.

Use LangGraph como hoje (`StateGraph`, `AsyncSqliteSaver`, `thread_id` único por execução). Falha → job `failed` com erro visível, sem fallback silencioso.

## 4. Backend: outras rotas

- `DELETE /api/graph/nodes/{id}`:
  - grava tombstone no nó e nas cadeias que o referenciam;
  - remove só a seção gerenciada da nota, **não apaga o arquivo do usuário**; se a nota ficar vazia e tiver sido criada pelo harness, pode ser removida.
- `PUT /api/graph/positions` com body `{node_id: {x, y}}`.
- `POST /api/chats` aceita `graph_context: [node_id]` (máx. 64):
  - a sessão guarda `graph_context` e o contexto do prompt recebe as proposições ("[id] nome: afirmação") mais as cadeias entre elas;
  - em PRACTICE, vira o material da sessão (a Fase 9 usa isso).
- **Modelo e esforço por sessão:**
  - `POST /api/chats` aceita `model_id` e `effort` opcionais; `PUT /api/chats/{id}/settings` com `{model_id, effort}`;
  - `SessionRecord.slot_override: ModelSlotConfig | None` substitui `slots.strong` naquela sessão;
  - mudar o modelo fecha o processo persistente, e o próximo turno reidrata.
- **Uso:**
  - os engines reportam o uso por turno quando o provedor informa. O `agy` traz `usage` no evento `result`; o SDK traz `usage_metadata`;
  - `SessionRecord.usage: {input_tokens, output_tokens, thinking_tokens, turns}` acumula;
  - `GET /api/usage` devolve `{today: {...}, total: {...}, by_session: [...top 10]}`.
  - Os jobs em background também somam ao total.

## 5. Frontend

**Home** (`app/page.tsx`, `components/graph-view.tsx`, `graph-canvas.ts`, `composer.tsx`):
- **Layout:** grafo em tela cheia; *chrome* flutuante no topo; dock do composer flutuante embaixo, centralizado, com largura máxima de cerca de 720 px.
- **Composer:**
  - `TEACH | PRACTICE`;
  - textarea;
  - enviar (↵);
  - barra **Ditar** larga clicável, que usa o hook `use-dictation` existente;
  - seletor de **modelo**, com a lista de `/api/setup/models?engine=<engine do slot strong>`; o padrão é o modelo do slot strong;
  - seletor de **esforço** (`low | medium | high`), que fica oculto/desabilitado quando o id do modelo já fixa o esforço (sufixo `-low`/`-medium`/`-high`…);
  - a escolha vai no `POST /api/chats`.
- **Seleção de nós:** com Shift/⌘+clique, ou pelo botão "selecionar" do cartão. Aparece um chip "N nós selecionados · [Ensinar a partir daqui] [Praticar estes] [Limpar]" acima do composer, que envia `graph_context`.
- **Canvas:**
  - regiões por cluster (`clusters[]`), com rótulo de cluster quando o tamanho é ≥ 3;
  - arestas de cadeia;
  - rótulos que aparecem com o zoom;
  - arrastar persiste a posição;
  - nós fantasmas do roadmap (vazados e tracejados) quando ⇶ Roteiro está ativo, com arestas tracejadas para os `linked_node_ids`.
- **Engrenagem:** controles de exibição (tamanho do nó, espessura da aresta, tamanho do rótulo, zoom para mostrar rótulos, intensidade das regiões) e física (repulsão, atração, comprimento da aresta, gravidade central, coesão de cluster). Salvos em `localStorage` (`learnharness:graph-settings`) com try/catch, e "Restaurar padrão".
- **Indicador de uso:** pílula discreta com os tokens de hoje (por exemplo "12,4k tok hoje"); o popover mostra total e top sessões.
- **Cartão do nó:** nome, afirmação, sessões (links com `#message-<id>`), "Abrir nota" (painel existente), "Selecionar" e "Excluir" (diálogo).
- **Chains:** tabela com filtro, ordenação, linhas `A ∧ B ⟹ C` e seleção por checkbox que alimenta a mesma seleção de nós.

**Página da sessão:**
- cada mensagem tem a âncora `id="message-<id>"`;
- um hash na URL rola até a mensagem e faz flash;
- chip do modelo no cabeçalho, que abre o seletor e chama `PUT /settings`;
- uso da sessão no cabeçalho.

**Setup:** a etapa Trilha começa em "Livre", com o texto "opcional — você pode ligar depois".

Tudo com tokens do design system (sem hex cru), i18n PT-BR/EN e SSE notify → fetch (sem polling).

## 6. Testes obrigatórios

- **Merge (puro):**
  - link-append une aliases e proveniência;
  - tombstone;
  - fusão de cadeias;
  - descarte de cadeias redundantes;
  - cobertura por fingerprint.
- **Pipeline com FakeEngine:**
  - extrai, audita (funde paráfrase) e grava `nodes`/`chains`/`coverage` mais as notas;
  - uma nota existente do usuário é adotada sem perder texto;
  - uma segunda execução sem texto novo não extrai nada.
- **Gatilho por tokens** ao fim da execução, e na conclusão.
- **Rotas:** `GET /api/graph` (formato, roadmap com trilha, legado), delete node, positions, `graph_context` no prompt, settings por sessão (o processo persistente é fechado), uso acumulado e `/api/usage`.
- **Frontend:** lógica pura testável em `lib/` (seleção, layout fantasma, configurações com clamp, parse de modelo que fixa esforço). `tsc`, `npm test` e `build` passam.
