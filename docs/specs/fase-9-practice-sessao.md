# Fase 9: Practice como sessão (substitui os problem sets em lote)

**Decisão do usuário:** substituir os problem sets em lote pelo modelo de sessão do upstream.

**Licença:** reescrita própria. Nada de texto ou código do upstream (AGPL).

Os invariantes do `AGENTS.md` valem: só TEACH/PRACTICE, `core/` puro, um único SSE, Vault não destrutivo.

## 1. Comportamento

1. **Abrir uma sessão PRACTICE:**
   - pelo composer, em modo PRACTICE ("o que você quer praticar?");
   - por **"Praticar estes"** com nós selecionados no grafo (o `graph_context` vira o material);
   - por um item da trilha.
2. **Sem aquecimento:** o agente abre direto com o primeiro problema.
3. **Um problema por vez.** O agente chama `problem` e encerra o turno.
4. **As tentativas do aluno** chegam pelo **dock de prática** ("Seu raciocínio / tentativa"):
   - podem ser um rascunho de raciocínio ou uma resposta final; o agente decide pelo texto qual dos dois é;
   - **uma resposta declarada não é sinal de progresso**: o agente verifica o raciocínio.
5. **Escada de dicas R0–R5.** É sempre **um degrau por pedido** e nunca revela o que o aluno ainda consegue gerar sozinho:
   - **R0:** só devolve a pergunta ("o que você já tentou?") e incentiva a tentar;
   - **R1:** pista de categoria (que tipo de ideia resolve isso);
   - **R2:** nomeia o princípio ou a proposição relevante;
   - **R3:** monta o primeiro passo ou a estrutura;
   - **R4:** resolução parcial guiada, deixando o fecho para o aluno;
   - **R5:** caminhada completa. O aluno ainda reconstrói antes da revelação.
6. **Fecho.**
   - O agente chama `conclude` com:
     - `outcome`: `solved | solvedWithHints | movedOn | surrendered`;
     - `verdict`: uma frase;
     - `rung`: o degrau mais alto usado, ou null;
     - `miss_class`: `cue | discrimination | execution | careless | structural`, ou null;
     - `retest`: bool.
   - A **solução-modelo** (escrita no `problem` e escondida até aqui) é revelada na UI.
   - O agente escreve as palavras de fechamento e **encerra o turno**. O próximo problema só vem quando o aluno pedir ("Próximo problema" ou Enter vazio no dock).
7. **Modos:**
   - `recall`: lembrar ou reconstruir uma proposição ou cadeia sem o nome dado;
   - `discrimination`: decidir qual ideia se aplica entre parecidas;
   - `composition`: combinar duas ou mais ideias num problema novo.
8. **Doutrina:**
   - intercalar alvos e modos;
   - mirar cerca de 85% de sucesso por recuperação;
   - os problemas não nomeiam o conceito-alvo;
   - variar superfície e contexto;
   - fechar a sessão com retestes do que falhou.
9. **Descartar.** O aluno pode descartar um problema ativo (Esc → "Descartar problema?"). Isso sintetiza um `conclude(outcome="dismissed")` sem nota.
10. **Material:**
    - `graph_context` quando existir;
    - os dois tipos de material abaixo entram no prompt;
    - o agente também pode consultar o grafo com `graph_search`.

    **Fila de reteste:** problemas com `retest=true` e ainda sem um `solved` posterior para os mesmos alvos, lidos de `.harness/practice-log.jsonl`. Alvos que saíram `solved`/`solvedWithHints` sem reteste pendente não entram.

    **Sugestão sem contexto:** as proposições das sessões TEACH mais recentes, até 20.

## 2. Ferramentas MCP (só em sessões PRACTICE)

As ferramentas de pergunta da Fase 8 continuam disponíveis em PRACTICE só como `ask_user_question`. `probe`, `quiz`, `plan_init` etc. são recusados em PRACTICE com texto corretivo.

| Ferramenta | Parâmetros | Efeito |
|---|---|---|
| `problem` | `statement, mode: "recall"\|"discrimination"\|"composition", model_solution, target: list[str] = []` (ids `n_…` do grafo; nomes são resolvidos para ids; desconhecido → erro corretivo) | Recusado se já houver um problema ativo. Registra o problema ativo e devolve "Problema apresentado; encerre o turno e espere a tentativa". **Não bloqueia.** |
| `conclude` | `outcome, verdict, rung: "R0".."R5"\|None, miss_class\|None, retest: bool` | Recusado sem problema ativo. Fecha o problema, grava o log, revela a solução e devolve "Escreva o fechamento e encerre o turno; o próximo problema espera o aluno". |
| `graph_search` | `query: str, limit: int = 10` | Somente leitura, **também disponível em TEACH**. Devolve `[{id, name, statement, session_title}]` por sobreposição de tokens em nome, afirmação e aliases. |

Os textos de cura e normalização (LaTeX duplo, listas em string JSON) são os mesmos da Fase 8.

## 3. Contratos e persistência

**`core/contracts/practice.py`:**
- `PracticeProblem`:
  - `id, statement, mode, target: list[str], model_solution, created_at`;
  - `attempts: list[{at, text}]`;
  - `outcome | None, verdict, rung, miss_class, retest, concluded_at`.
- `PracticeState`: `active_problem_id | None, problems: list[PracticeProblem]`.
- `SessionRecord.practice: PracticeState` (default vazio).
- Os contratos de **problem set em lote** (`PracticeSet`, `HintStep`, `RubricCriterion`, `PracticeAttemptGrade` e o `PracticeProblem` antigo) **saem**.
- Os contratos de revisão de desenho (`DrawingFollowUpQuiz`, `DrawingReviewResult`) **ficam**; mover para `core/contracts/drawing.py` se ficar mais limpo, atualizando os imports.

**Serialização em `GET /api/chats/{id}`:**
- `practice.problems[]` com `model_solution` **omitido** enquanto o problema está ativo, e presente depois de concluído;
- `practice.active_problem_id`.

**Entradas do aluno:** `POST /api/chats/{id}/messages` ganha `kind: "text" | "attempt" | "next"` (padrão `"text"`):
- `attempt` anexa a tentativa ao problema ativo e vira uma mensagem `user` com `content` prefixado por `"Tentativa:\n"`;
- `next` vira a mensagem "Próximo problema, por favor.";
- os três disparam a execução.

`POST /api/chats/{id}/practice/dismiss`:
- descarta o problema ativo, com `outcome="dismissed"`, sem log de nota;
- anexa uma mensagem de sistema curta para o modelo ("o aluno descartou o problema; não o retome");
- não dispara execução.

**`.harness/practice-log.jsonl`** (append-only): uma linha por `conclude`:
`{at, session_id, problem_id, mode, target, outcome, rung, miss_class, retest}`.

**Vault:**
- a sessão PRACTICE tem nota em `Aulas/YYYY-MM-DD Prática — <título>.md`;
- uma seção gerenciada por problema: enunciado, tentativas resumidas, desfecho, degrau, solução-modelo;
- merge não destrutivo como nas aulas.

**Fase:** sessões PRACTICE ficam em `phase="teaching"` (sem probing/planning), com `prompt_family="practice"`.

**Extração:** sessões PRACTICE **não** alimentam o rastro. O grafo guarda ideias verdadeiras, não desempenho.

## 4. Remoções (problem sets em lote)

- `pipelines/practice_gen.py`
- O job `practice_gen` em `services/jobs.py`
- As rotas `/api/practice/sets`, `/api/practice/generate` e `/api/practice/sets/{id}/problems/{id}/attempt`
- Os testes correspondentes
- O frontend em lote (`components/practice-view.tsx` e o uso dele)

Os dados antigos em `.harness/practice*` ficam no disco, ignorados. `/api/demos`, `/api/jobs*` e `/api/jobs/extract` **ficam**: mover para um arquivo de rotas adequado se o `practice.py` ficar vazio.

## 5. Prompts (`prompts/practice/`)

Reescrever em fragmentos `NN-*.md`:
- `10-opening`: sem aquecimento; mecânica das ferramentas; pausa após `problem` e após `conclude`;
- `20-doctrine`: modos, intercalação, faixa de 85%, não nomear o alvo, variação, retestes no fim;
- `30-hints`: a escada R0–R5 e "um degrau por pedido";
- `40-reading-attempts`: rascunho vs resposta; verificar o raciocínio, não a resposta declarada; classificar o erro (`cue`, `discrimination`, `execution`, `careless`, `structural`, com definições);
- `50-conclude`: quando usar cada `outcome`, `retest`, e não reabrir problemas descartados.

O subconjunto `shared/` em PRACTICE continua o mesmo da Fase 8: sem `50-questions.md`, mas com a voz, a precisão, o modelo mental e a formatação. O `TURN_RULES` de PRACTICE fica próprio, com as ferramentas `problem`/`conclude`/`graph_search`/`ask_user_question`.

## 6. Frontend

**Página da sessão PRACTICE** (substitui o `practice-view` em lote):
- transcrição em prosa, como no TEACH;
- `ProblemCard`: enunciado, chip do modo e chips dos alvos (nomes do grafo; clicar foca o nó na Home);
- `AttemptCard`: tentativa do aluno, em itálico, com trilho lateral;
- `ConcludeCard`: desfecho, veredito, degrau, classe do erro, selo de reteste e **solução-modelo** recolhível;
- `PracticeDock`:
  - substitui o composer;
  - com problema ativo: textarea "Seu raciocínio / tentativa", Ditar e Enviar (`kind=attempt`);
  - sem problema ativo e com o agente ocioso: botão **"Próximo problema"**, e Enter vazio também envia `next`; ou uma mensagem livre (`kind=text`);
  - Esc com problema ativo abre o diálogo "Descartar problema?" e chama `/practice/dismiss`.
- **Cabeçalho:** chip "Prática", o contador de problemas (resolvidos / total) e o modelo e uso da Fase 8B.

**Home:** "Praticar estes" e o composer em PRACTICE criam a sessão. O link antigo de "problem sets" sai.

**Botão "Extrair para o grafo":**
- no cabeçalho de sessões TEACH e no menu da sessão na sidebar;
- chama `POST /api/graph/extract/{id}` e mostra o job em BACKGROUND AGENTS;
- traz para o rastro as sessões antigas.

Tudo com tokens, i18n PT-BR/EN e SSE notify → fetch.

## 7. Testes

- **Ferramentas:**
  - `problem` com outro ativo → recusa;
  - `conclude` sem ativo → recusa;
  - alvo desconhecido → recusa;
  - nome resolvido para id;
  - `probe`/`quiz` recusados em PRACTICE;
  - `graph_search` em TEACH e PRACTICE.
- **Fluxo com FakeEngine:** abrir → `problem` → `attempt` → dica (prosa) → `attempt` → `conclude(solved, rung R2)` → log, nota e solução revelada → `next` → novo `problem`.
- **dismiss:** sem log de nota; o próximo turno não reabre o problema.
- **Serialização:** `model_solution` oculto enquanto ativo.
- **Fila de reteste e sugestão sem contexto** no prompt.
- **Remoções:** nenhuma rota de problem set responde; nenhum import quebrado.
- **Frontend:** lógica pura em `lib/` testada (estado do dock, decodificação de `practice`). `tsc`, `npm test` e `build` passam.
