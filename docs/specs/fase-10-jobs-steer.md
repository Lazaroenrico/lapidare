# Fase 10: jobs em background que voltam para a aula

Os invariantes do `AGENTS.md` valem. Escrevemos tudo do zero; não copiar texto nem código do upstream (AGPL).

A base já existe:
- `SessionService.deliver_steer(session_id, "job", content, details)`: entrega no próximo turno e acorda a sessão ociosa (`tests/unit/test_steers.py`);
- `config.agent.tools` (`research`/`pdf`/`visual`/`demo`).

## 1. Comportamento

- O professor pode **despachar trabalho em segundo plano** e continuar ensinando. Ele nunca espera nem consulta o resultado: o resultado chega sozinho como *steer* (em qualquer momento, se a sessão estiver ociosa; no próximo turno, se estiver ocupada).
- Se o resultado não vier, o professor segue em prosa e nunca inventa um resultado.
- Cada job aparece em BACKGROUND AGENTS (`JobManager`) com kind, rótulo, atividade, tempo e erro.
- Ao terminar, cria um cartão na transcrição. Os cartões de pesquisa e de PDF ficam recolhidos e se expandem para mostrar o resumo e as fontes. Visual e demo mostram o artefato.
- Toggles desligados em `config.agent.tools` fazem a ferramenta recusar com texto corretivo ("a pesquisa está desativada nas Configurações; siga sem ela").
- Concorrência: o semáforo do `JobManager` já existe.

## 2. Ferramentas MCP (TEACH; `research` e `read_pdf` também em PRACTICE)

| Ferramenta | Parâmetros | Execução do job |
|---|---|---|
| `research` | `question, context=""` | Pesquisa na web com fontes. |
| `read_pdf` | `path, question` | `path` relativo ao vault (só dentro dele; `.pdf`). Extrai com `pypdf`, faz triagem por página com busca de termos, lê as páginas relevantes e responde com as páginas citadas como (p. N). Recusa se nada foi lido. |
| `visual` | `brief` | O modelo gera um SVG autocontido. |
| `spawn_demo` (existente) | `title, topic, description` | O job atual passa a devolver o steer ao terminar. |

Todas retornam na hora: `{ok, job_id, note: "Despachado. Continue ensinando; o resultado chegará sozinho — não espere nem consulte."}`.

**Detalhes do `research`:**
- Por engine, nesta ordem:
  - **agy:** um job `run_structured` num workspace próprio cujo *gate* libera **apenas** as ferramentas de leitura da web do agy (`search_web`, `read_url_content`; confirmar os nomes pelo `system` init de uma execução real e salvar a transcrição em fixture);
  - **SDK `google-genai`:** ferramenta `google_search` (grounding);
  - **gemini CLI:** a ferramenta `google_web_search`, por um workspace com allow-list.
- Sem engine capaz, o job falha com uma mensagem clara.
- Resultado: `{brief (markdown com as seções Resumo / Achados citados / Fontes / Lacunas), sources: [{title, url}]}`.

**Detalhes do `visual`:**
- Validação:
  - XML bem formado, raiz `<svg>` com `viewBox`;
  - sem `<script>`, `<foreignObject>`, `on*=` nem `href` externo (só `#…` e `data:`);
  - até 300 KB.
- Cores: sugerir a paleta grafite; não rejeitar por cor.
- Se for inválido, pede ao modelo uma correção até 2 vezes com os erros. Depois falha.
- Grava em `<viz>/visuals/<slug>.svg`.

**Steer de resultado:**
- `content` é o texto para o modelo, por exemplo: "A pesquisa '…' terminou. Resumo: … Cite as fontes pelo título quando usar." ou "O visual está pronto e foi inserido na aula; refira-se a ele pelo que mostra."
- O de falha diz: "… falhou (motivo). Siga em prosa; não invente o resultado."
- `details`: `{job_id, kind, status: "done"|"failed", result | error}`.
- Um steer por job, entregue uma única vez: garantir idempotência pelo `job_id`.

**Nota da aula:** o visual entra como `![[viz/visuals/<slug>.svg]]` e a demo como link, na seção do nó corrente. A pesquisa entra como citação recolhível (`> [!note]- Pesquisa: …`).

## 3. Prompts

Fragmento novo `teacher/55-background-jobs.md` (e uma linha no `practice/10-opening.md` sobre `research`/`read_pdf`). Conteúdo:
- quando despachar: verificar um fato de que você não tem certeza, buscar uma fonte para citar, um PDF do aluno, ou uma figura que mostre o que a prosa não mostra;
- anunciar em uma frase e seguir ensinando;
- usar o resultado quando ele chegar, citando as fontes;
- nunca inventar.

Atualizar o `TURN_RULES`.

## 4. Frontend

**Cartões na transcrição para mensagens `steer_kind == "job"`**, decididos por `details.kind`:
- `research`: selo "Pesquisa concluída", recolhido; expandido mostra o resumo em markdown e as fontes como links;
- `read_pdf`: igual, com o nome do arquivo e as páginas;
- `visual`: o SVG renderizado como `<img src="data:image/svg+xml;base64,…">` (nunca no DOM), com baixar, tela cheia e inverter brilho;
- `demo`: o iframe da demo, que já existe em `demo-iframe.tsx` com `sandbox="allow-scripts"`;
- falha: um chip discreto com o erro.

**Cartão de despacho** (a mensagem do assistente onde a ferramenta foi chamada não é visível). Para não perder o contexto, mostrar no lugar de chegada do steer um rótulo "Despachado → concluído" com o tempo decorrido.

Mensagens `steer_kind == "learner"` aparecem como mensagens do aluno com o selo "enviada durante o turno".

Tudo com tokens e i18n.

## 5. Testes

- Recusa por toggle.
- `read_pdf` fora do vault ou sem ser PDF → recusa.
- Validador de SVG: casos bons e cada rejeição.
- Job `research` com FakeEngine, para cada caminho de engine que for possível simular.
- Steer entregue uma vez, mesmo com retry do job.
- Steer de falha.
- Nota da aula com o embed do visual.
- Fixture real do agy com a ferramenta de busca, se puder capturar.
- Frontend: decodificação dos `details` em `lib/` e testes.
