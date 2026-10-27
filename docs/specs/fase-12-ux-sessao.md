# Fase 12: UX da sessão

Os invariantes do `AGENTS.md` valem. A base já existe:
- `POST /api/chats/{id}/steer {content}` e `SessionService.deliver_steer`;
- `lib/keyboard.ts` mais `components/use-shortcut.ts`, registro com os ids `find`, `rename`, `abort`, `sessionSearch`, `newSession`, `toggleSidebar`, `goGraph`, `toggleThinking`, `dictate`, `modelPicker`, `help`, `settings`, `continueTrack`. Use `useShortcut(id, handler)` e não crie listeners de teclado próprios para esses atalhos.

## 1. Backend

1. **404 correto:** `GET`/`PUT`/`DELETE /api/chats/{missing}` → 404 (hoje um `KeyError` vira 500).
2. **Renomear:** `PUT /api/chats/{id}` com `{title}` (1–200 chars) altera o título. A nota da aula mantém o caminho; só o título no frontmatter ou cabeçalho gerenciado muda.
3. **Excluir:** `DELETE /api/chats/{id}?mode=preserve-graph|delete-nodes`.
   - Move `.harness/sessions/<id>.jsonl` para `.harness/trash/` (sem apagar) e o tira das listas.
   - **Não** apaga a nota em `Aulas/`, que é arquivo do usuário no Vault.
   - `delete-nodes`: via `GraphService`, remove a proveniência da sessão nos nós e cadeias (linha *unlink* append-only `{id, unlink_session: <id>}`). Nós e cadeias que ficarem sem proveniência viram tombstone, e as notas seguem as regras de exclusão da Fase 8B.
   - Recusa (409) enquanto há turno rodando.
4. **Abortar:** `POST /api/chats/{id}/abort`.
   - Cancela a task da sessão (o caminho `CancelledError` → `interrupted` já existe) e fecha o processo persistente.
   - Uma pergunta pendente é resolvida como **dispensada**.
5. **Dispensar pergunta:** `POST /api/chats/{id}/questions/dismiss`.
   - Resolve a pergunta pendente com `dismissed: true`: o modelo recebe "o aluno dispensou a pergunta; não a repita".
   - Sem nota e sem entrada no `quiz-log`.
   - Respostas dispensadas aparecem na transcrição como "dispensada".
6. **Exportar:** `GET /api/chats/{id}/markdown` devolve `text/markdown` com `Content-Disposition`. Conteúdo: título, prosa, perguntas e respostas (com confiança e raciocínio), plano final, problemas da prática e cartões de job resumidos.
7. **Compactação de contexto:**
   - **Gatilho:** histórico estimado (`chars/4` das mensagens desde a última compactação) > `config.agent.compaction_tokens`. Roda no fim do turno, antes do próximo, e o próximo turno espera.
   - **Resumo:** o slot `background` resume com as seções obrigatórias: entendimento do aluno e evolução, arco do ensino, plano atual na íntegra, momento atual (pergunta ou problema em aberto).
   - **Armazenamento:** `SessionRecord.compaction = {summary, first_kept_message_id, tokens_before, at}`. Mantém a cauda literal de cerca de 20k tokens.
   - **Uso no prompt:** a montagem de histórico (persistente: `compose_prompt` e reidratação; não persistente: `PERSISTED HISTORY`) usa resumo mais cauda.
   - **Status:** `execution_status` ganha `"compacting"` enquanto roda.
   - Mensagens antigas continuam persistidas.
8. **Lista de sessões:** `GET /api/chats` traz `title, mode, updated_at, execution_status, pending (bool)` para a sidebar.

## 2. Frontend

1. **Mandar mensagem durante o turno.** Na sessão TEACH, o composer fica habilitado enquanto o agente roda. Enviar vai para `/steer`, e a mensagem aparece com o selo "na fila" até ser entregue (`delivered`). Em PRACTICE, o dock usa o mesmo caminho quando o agente está rodando.
2. **Esc**, pela ordem:
   - com pergunta pendente: "Dispensar esta pergunta?" → `/questions/dismiss`;
   - com problema ativo (PRACTICE): o diálogo que já existe;
   - com turno rodando: "Abortar este turno?" → `/abort`.
   - Usa `useShortcut("abort")`.
3. **Busca na sessão (⌘F):** barra de busca literal, sem distinção de maiúsculas, com destaques via CSS Custom Highlight API (fallback: `<mark>`), ↑/↓ entre ocorrências e contador.
4. **Renomear (F2 ou clique no título):** edição inline → `PUT`; a sidebar se atualiza via SSE.
5. **Sidebar:**
   - busca difusa nas sessões (⌘⇧F foca), com ↑/↓ e Enter;
   - filtro Ensino / Todas / Prática;
   - status por linha: esperando resposta, problema aberto, compactando, trabalhando, ou o tempo relativo;
   - menu "⋯" (já existe, com "Extrair para o grafo") ganha Renomear, Exportar Markdown e Excluir.
   - O diálogo de excluir tem a caixa "Remover também os nós do grafo que só vieram desta sessão" (`mode=delete-nodes`).
6. **Divisória de compactação** na transcrição ("Contexto resumido aqui") e o placeholder "COMPACTANDO CONTEXTO…" enquanto roda.
7. **Atalhos globais** por `useShortcut`:
   - `newSession` → `/`, com o foco no composer;
   - `toggleSidebar`;
   - `goGraph` → `/`;
   - `sessionSearch`.
   - A folha de atalhos (`help`) é da Fase 13.

Tudo com tokens, i18n e SSE notify → fetch.

## 3. Testes

- **Backend:** cada rota acima (404, renomear, excluir com cada modo e unlink no grafo, abortar com pergunta pendente, dispensar, exportar) e a compactação (gatilho, seções, prompt com resumo mais cauda, `first_kept`).
- **Frontend:** lógica pura (busca difusa, ordem do Esc, busca literal com offsets, máquina de estado da fila) em `lib/` com testes.
