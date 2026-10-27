# Fase 14: várias trilhas e MCP genérico

**Decisão do usuário (2026-10-27):** várias trilhas guardadas lado a lado, com **uma em foco por vez** e troca rápida no chip. O uso pensado inclui matérias de faculdade, cursos e repositórios. O MCP de conteúdo deve ser **genérico** (qualquer servidor), sem nada fixo de "Praxis".

Os invariantes do `AGENTS.md` valem: a trilha vive no Setup e nas Configurações e aparece na Home só como chip; só TEACH/PRACTICE; o Vault é não destrutivo.

## 1. Modelo (`core/contracts/config.py`)

**`TrackConfig` ganha campos:**
- `id: str` (`trk-<8hex>`);
- `title: str`;
- `archived: bool = False`;
- `created_at: str = ""`;
- `source: Literal["repo", "github", "goal", "manual", "legacy"] = "goal"`;
- `github_url: str | None = None`.

Os campos atuais continuam: `mode`, `repo_path`, `learning_md_path`, `goal_description`, `active_item_id`, `queue`.

**`HarnessConfig`:**
- ganha `tracks: list[TrackConfig] = []` e `active_track_id: str | None = None`;
- métodos `active_track() -> TrackConfig | None` e `find_track(id)`.

**Migração na leitura:**
- se o JSON tiver a chave legada `track` e não tiver `tracks`, e essa trilha tiver fila ou modo diferente de FREE, ela vira `tracks[0]` com `id` novo, `title` derivado (nome do repositório, objetivo ou "Trilha principal"), `source="legacy"`, e fica ativa;
- uma trilha FREE vazia não vira trilha;
- na gravação, só o formato novo; a chave `track` some.

**Compatibilidade:** o código que lia `config.track` passa a usar `config.active_track()`, tratando `None` como "sem trilha / livre".

Os ids de item são únicos **dentro** da trilha. O par `(track_id, item_id)` identifica um passo.

## 2. Sessões

- `SessionRecord.track_id: str | None`.
- `POST /api/chats` aceita `track_id` junto com `track_item_id`. Sem `track_id`, usa a trilha ativa.
- A reutilização de sessão aberta por item de trilha passa a considerar o par.
- O contexto do prompt (`"track": …`) usa a trilha da sessão.
- `tracks.complete` e `track_foundation` atuam na trilha da sessão.

## 3. Serviço e rotas

**`TrackService`:** `generate(track_id)`, `complete(track_id, item_id)`, `foundation(session_id, …)`. O job `track_gen` recebe `{track_id}`, com chave `track:<id>`.

**A nota de trilha no vault** (a seção gerenciada em `00 Mapa.md` ou equivalente, ver `_save`) mostra **uma seção por trilha não arquivada**: título, checklist e a marcação da ativa. O resto da nota é preservado.

**Rotas** (`api/routes/tracks.py`):

| Rota | Comportamento |
|---|---|
| `GET /api/tracks` | `[{id, title, source, mode, archived, active, created_at, progress: {done, total}, next_item: {id, title} \| null, generating: bool, error: str \| null}]`. `generating` e `error` vêm do job `track:<id>`. |
| `POST /api/tracks` | Body `{title, source, repo_path?, github_url?, goal_description?, items?: [str], activate: bool = true}`. Detalhes abaixo. Devolve a trilha. |
| `PUT /api/tracks/{id}` | Body `{title?, archived?, goal_description?}`. Arquivar a ativa ativa a próxima não arquivada. |
| `POST /api/tracks/{id}/activate` | Ativa a trilha. |
| `DELETE /api/tracks/{id}` | Remove do config. As sessões continuam, com `track_id` órfão exibido como "trilha removida"; nada no Vault é apagado. |
| `POST /api/tracks/{id}/regenerate` | Refaz a fila de trilhas `repo`/`github`/`goal`. Preserva o `completed` dos itens com o mesmo título. |

Detalhes do `POST /api/tracks` por `source`:
- `manual`: `items` vira a fila direto, um passo por linha;
- `goal`: `goal_description` é o objetivo ou a **ementa da disciplina** (texto livre longo, até 20k chars). Dispara `track_gen`;
- `repo`: `repo_path` local. Dispara `track_gen`;
- `github`: clona como o import do GitHub (`vault/github_source.py`) e usa o clone como `repo_path`. Dispara `track_gen`.

**`config:updated`** é emitido em toda mudança.

**Status:**
- `GET /api/setup/status` e `_serialize_config_for_frontend` incluem `tracks` (o formato do `GET /api/tracks`) e `active_track_id`;
- `track` continua existindo como a **trilha ativa** no formato antigo (`active`, `current_step_id`, `items`), para não quebrar o chip atual até o frontend migrar.

**Setup** (`POST /api/setup/complete`): o `track` do payload, se não for FREE, **cria uma trilha** (não substitui as outras).

**Import do GitHub** (`use_as_track`):
- cria uma **trilha nova** (`source="github"`, título = `owner/repo`) e a ativa;
- `replace_track` deixa de existir; aceitar e ignorar, por compatibilidade.

**Roadmap do grafo:**
- cada item de `roadmap[]` ganha `track_id` e `track_title`;
- inclui as trilhas não arquivadas;
- os ids passam a ser `track:<track_id>:<item_id>`.

## 4. MCP genérico

- Remover do Setup o cartão fixo "Praxis" (`components/setup-dialog.tsx`: `praxisActive`/`praxisUrl` e as strings `sdPraxis*`). A etapa MCP do Setup passa a usar o gerenciador genérico já existente (`components/mcp-server-manager.tsx`), com estes campos: nome livre, transporte `http`/`sse`/`stdio`, URL ou comando e args, token opcional (vai para o cofre de segredos), testar, e lista de servidores.
- O placeholder do nome em `mcp-server-manager.tsx` deixa de ser `praxis` e passa a ser genérico, por exemplo `meu-servidor`.
- Backend (`vault/transcript_importer.py`, `api/routes/import_content.py`):
  - o frontmatter usa `mcp_server` e `mcp_item_id`;
  - `origem` vira `MCP: <servidor>` / `Import`;
  - a leitura aceita `praxis_id` antigo, para que a detecção de "já importado" continue funcionando com fontes antigas.
- Comentários e docstrings podem citar Praxis só como exemplo.

## 5. Frontend

**Chip da Home** (`composer.tsx`): `⇶ <título da trilha> · Próximo: <item> [Continuar ↵] ▾`.
- O `▾` abre um menu com as trilhas não arquivadas: título, barra de progresso `feitos/total`, a marca da ativa e "gerando…" ou erro.
- Clicar ativa a trilha (`POST /activate`).
- O fim do menu tem "＋ Nova trilha" e "Gerenciar trilhas" (→ `/settings#tracks`).
- Sem trilhas, o chip fica oculto, como hoje.

**Configurações → Trilhas** (nova seção):
- lista com progresso, ativar, renomear inline, arquivar/desarquivar, regenerar, excluir (com confirmação) e status do job;
- "Nova trilha" abre um diálogo com abas:
  - **Objetivo ou ementa:** título mais textarea grande ("cole a ementa da disciplina ou descreva o objetivo");
  - **Lista de tópicos:** um por linha, para matérias com cronograma pronto;
  - **Repositório local:** caminho;
  - **GitHub:** URL; reaproveitar a validação do import.

**Sidebar:** filtro por trilha (Todas / Sem trilha / cada trilha) e uma tag curta da trilha nas linhas de sessão.

**⇶ Roteiro no grafo:**
- cor por trilha, com tons do `toneAlpha` existente, e legenda;
- alternância "Só a trilha em foco / Todas".

**Setup:** a etapa de trilha cria a primeira trilha (opcional); a etapa MCP fica genérica (§4).

**Import GitHub:** o rótulo da opção passa a ser "Criar trilha a partir deste repositório".

Tudo com tokens, i18n PT-BR/EN e SSE notify → fetch (`config:updated` e `jobs:updated`).

## 6. Testes

- **Backend:**
  - migração do `track` legado (com e sem fila; FREE vazio não vira trilha);
  - CRUD e ativação; arquivar a ativa;
  - cada `source` de criação (`manual` sem job; `goal`/`repo` com job e chave por trilha; `github` com o clone simulado);
  - sessão com `track_id` e `complete` na trilha certa;
  - roadmap com várias trilhas;
  - import GitHub criando uma trilha nova sem apagar as outras;
  - frontmatter `mcp_server`/`mcp_item_id` e leitura do `praxis_id` antigo.
- **Frontend:** lógica pura (progresso, ordenação, cores por trilha, filtro da sidebar) com testes.
