# Fase 8: núcleo pedagógico (paridade de método com o learnharness upstream)

**Fonte da verdade** para backend, prompts e frontend nesta fase.

**Origem:**
- A referência é o método do `amosblomqvist/learnharness` v0.3.8 (AGPL-3.0).
- **Decisão do usuário:** reescrever com prompts e código próprios.
- **Nunca** copiar texto ou código do upstream. Implementamos o mesmo *comportamento*, com as nossas palavras e adaptado ao Vault, PT-BR/EN e conectores Google.

Os invariantes do `AGENTS.md` continuam valendo: só TEACH/PRACTICE, `core/` puro, um único SSE, `Fontes/` somente-leitura e seções gerenciadas no Vault.

## 1. O ciclo de ensino (comportamento)

1. **Diagnóstico (fase `probing`).**
   - O agente torna o objetivo concreto, se preciso com `ask_user_question`.
   - Raciocina quais **trilhas de dependência** ("strands") o objetivo exige.
   - Para cada trilha, faz **busca binária** com perguntas graduadas (`probe` ou `recall`) até achar um **piso** (acerta com segurança) e um **teto** (erra ou não sabe):
     - entra perto do topo;
     - acerto confiante → sobe bastante;
     - acerto hesitante → sobe pouco;
     - erro → desce e investiga a concepção errada;
     - uma trilha que nunca quebrou ainda não terminou.
   - Termina com exatamente **uma** chamada `probe_done` (avaliação por trilha).
2. **Handoff.**
   - `probe_done` responde ao modelo "encerre o turno".
   - Quando a execução termina, o backend **agenda automaticamente um turno de handoff**, com o prompt de professor e o texto de handoff ("planeje o arco completo a partir do diagnóstico; chame plan_init; apresente o plano e encerre o turno").
3. **Planejamento (fase `planning`).**
   - O agente busca a **árvore mínima**: não reensinar o que já é sabido, nada fora do caminho.
   - As raízes devem ser verdades incondicionais *para este aluno*.
   - Chama `plan_init` (mermaid), apresenta a abordagem em prosa e **encerra o turno, sem ensinar ainda**.
   - A próxima mensagem do aluno é aceite ou pedido de mudança.
4. **Ensino (fase `teaching`).**
   - A transição acontece na primeira pergunta `quiz`/`explain` com `node_id`.
   - Um passo de raciocínio por vez: **prever → ensinar → verificar → reparar ou seguir**.
     - `type:"predict"` vem antes do passo: aparece aberta, é um empurrão (não um teste), e o ensino começa resolvendo a previsão.
     - `type:"check"` vem depois do passo: aparece recolhida atrás de "Verifique seu entendimento", é aplicada (não recitada), e cada distrator diagnostica um modelo errado específico.
   - **Uma pergunta por turno.**
   - Errou → diagnosticar, reparar e reensinar antes de construir em cima.
   - Lacuna revelada → chamar `plan_init` de novo (ids existentes são permanentes; adicionar fundação, podar, desviar).
5. **Campos de pensamento.**
   - `learner_thinking` é o raciocínio na pergunta. `reading_thinking` é o que o aluno anotou lendo a explicação, enquanto o *check* ainda estava recolhido.
   - São os dados primários do modelo mental. Nunca confundir os dois canais.
   - Muitas vezes vêm de ditado, então ler com tolerância a ruído.
6. **Confiança.**
   - Paradas do slider: `[0,30,50,70,90,100]`, padrão 50. Só existe em `quiz`/`probe`, e some com "Não sei".
   - Matriz:
     - acerto + alta → seguir;
     - acerto + baixa → frágil, um reforço;
     - erro + alta → concepção errada comprometida (sinal mais forte);
     - erro + baixa → correção pequena;
     - ≤ 1/n → desconfia do próprio palpite.
   - "Não sei" é lacuna genuína, não erro.

## 2. Ferramentas MCP (substituem `pose_quiz`)

Todas as ferramentas de pergunta **bloqueiam até a resposta** (o mecanismo `SessionService.pose` atual) e devolvem a resposta compacta (§3). "Não sei" é adicionado pela UI; o modelo nunca o inclui.

`options`:
- é `list[{label, value?} | str]`, normalizado como em `_normalize_choices`; em `ask_user_question` também aceita `description`;
- `value` padrão `A`, `B`, …;
- `correct` é `str | list[str]` e casa com o `value` ou o `label` de uma opção;
- mais de um correto exige `multi_select=true`.

`explanation` vem **antes** de `correct` no schema: escrever o porquê antes de comprometer a resposta.

| Ferramenta | Fase permitida | Parâmetros |
|---|---|---|
| `probe` | `probing` | `question, options, explanation, correct, multi_select=False, details=None` |
| `recall` | `probing` | `question, committed_answer, details=None` (resposta completa com raciocínio, imutável) |
| `quiz` | `teaching` ou `planning` (exige plano e `node_id` existente) | `type: "predict"\|"check", node_id, question, options, explanation, correct, multi_select=False, details=None` |
| `explain` | idem `quiz` | `type, node_id, question, committed_answer, details=None` |
| `ask_user_question` | qualquer | `question, options=None, multi_select=False, details=None`. Sem nota. A UI sempre oferece "Outro…". Opção recomendada primeiro, com "(Recomendado)". |
| `probe_done` | `probing`, uma vez, sem pergunta pendente | `strands: [{strand, assessment}] (≥1), summary=None`. `assessment` = piso, teto, concepções erradas, de onde construir. |
| `plan_init` | após `probe_done` | `mermaid: str, approach_prose: str = "", node_details: dict[id, {source_paragraphs?, four_dimensions?}] = {}` |
| `grade_recall` | qualquer | `question_id, verdict: "correct"\|"partial"\|"incorrect", feedback: str`. Registra a nota de uma resposta `recall`/`explain`. O modelo deve chamá-la antes de comentar a resposta. |
| `plan_advance` | `teaching` | `node_id, status: "mastered"\|"needs_review"`. O gate de mastery continua. "current" passa a ser **derivado**. |
| `track_foundation`, `spawn_demo` | inalteradas | |

**Recusas** voltam como erro de ferramenta legível, com texto que ensina a corrigir, para o modelo tentar de novo no mesmo turno:
- "chame plan_init antes de perguntas de ensino";
- "node_id desconhecido; use um destes: …";
- "probe_done já foi chamado";
- "há uma pergunta pendente".

## 3. Contratos (backend `core/contracts`)

**`QuizOption`**: `value, label, description: str | None = None`.

**`QuizPayload`** (mantém o nome por compatibilidade da API):
- `quiz_id, session_id, node_id, topic, question, details, created_at`;
- `kind: "quiz" | "explain" | "ask"` (padrão `"quiz"`);
- `mode: "PROBE" | "PREDICTION" | "CHECK" | None`:
  - `probe` → `kind=quiz, mode=PROBE`;
  - `recall` → `kind=explain, mode=PROBE`;
  - `quiz/explain` com `type` predict/check → `PREDICTION`/`CHECK`;
  - `ask` → `None`;
- `choices: list[QuizOption]` (2..6 para quiz/ask, vazio para explain);
- `multi_select: bool = False`;
- `correct_indices: list[int]` (quiz). `correct_index` fica como propriedade/compat igual a `correct_indices[0]`;
- `committed_answer: str | None` (obrigatório em explain);
- `explanation: str` (obrigatório em quiz; `""` nos outros).

**`QuizSubmission`**:
- `quiz_id, session_id`;
- `chosen_indices: list[int] = []` (aceita `chosen_index` legado);
- `is_dont_know`;
- `confidence: int | None` (0–100; obrigatório só em quiz sem "Não sei");
- `learner_thinking`, `reading_thinking: str = ""`;
- `text: str = ""` (resposta do explain);
- `other_text: str = ""` (ask "Outro…").

**`CalibrationResult`**:
- ganha `kind`, `chosen_indices`, `correct_indices`, `text`, `other_text`, `reading_thinking`;
- `correct: bool | None` (None em ask e em explain ainda não avaliado);
- `grade: "correct"|"partial"|"incorrect"|None` e `grade_feedback`;
- confiança e bandas são opcionais (None fora de quiz).

**Evidência de mastery:** CHECK quiz correto e calibrado (regra atual) **ou** CHECK explain com `grade="correct"`.

**Resposta compacta ao modelo** (só o que o aluno acrescentou, sem chaves vazias):
`{question_id, kind, dont_know?, answers?:[{index,label}], other?, text?, correct?, confidence?, calibration_band?, directive?, thinking?, thinking_while_reading?}`
- Para explain/recall, inclui `committed_answer` e a instrução "avalie com grade_recall".

**Diagnóstico:**
- `ProbeStrand {strand, assessment}`;
- `ProbeAssessment {strands: list[ProbeStrand] (≥1), summary: str | None, created_at}`;
- `SessionRecord.assessment: ProbeAssessment | None`.

**Fase:**
- `SessionPhase` usa `probing → planning → teaching → completed`.
- `awaiting_answer` e `consolidating` ficam só para registros antigos; o "esperando" é `execution_status="waiting"`.
- `SessionRecord.prompt_phase: str | None` registra o conjunto de prompt enviado por último ao processo persistente.

**Plano (`core/plan_mermaid.py`, puro):**
- `parse_mermaid_plan(text) -> (nodes, edges)` com o subconjunto:
  - `graph|flowchart TD|LR|BT|RL`;
  - `id[Título]`, `id("Título")`, id puro;
  - `-->`, `==>`, `-.->` (pré-requisito → dependente);
  - cadeias `a-->b-->c`;
  - comentários `%%`.
- Ids em slug minúsculo `[a-z0-9]+([-_][a-z0-9]+)*`. Erros com número da linha.
- `validate_plan` rejeita ids duplicados, extremidades desconhecidas, laços em si mesmo, arestas duplicadas e ciclos.
- `PlanNode.depends_on` vem das arestas.
- **Ids são permanentes:** um novo `plan_init` preserva o `status` mastered/needs_review dos ids mantidos.
- `kind` é derivado: sem dependências → `unconditional_truth`; sem dependentes → `goal`; senão `derived_step`.
- **Status derivado:** `current` = nó da pergunta quiz/explain mais recente com `node_id`; `visited` = anteriores; `pending` = o resto. `mastered`/`needs_review` persistem por `plan_advance`.

## 4. Prompts (`backend/src/learnharness/prompts/`)

Os fragmentos são `NN-nome.md` (regex `^\d+-[\w.-]+\.md$`), compostos em ordem e unidos por `\n\n---\n\n`.

**Diretórios:**
- `shared/`: identidade; voz (sem elogio, sem viés de concordância, sem profundidade encenada, registro seco); precisão (verificar, sinalizar incerteza); modelo mental (campos de pensamento); princípios de pergunta (distratores simétricos, cada um diagnóstico, uma pergunta por turno, correção estrita de recall); confiança; formatação (documento, não chat; LaTeX `$…$`/`$$…$$` com barras duplas no JSON; mermaid com rótulos entre aspas; citações `[[Fonte#^pN]]`); Vault.
- `prober/`: doutrina do diagnóstico (§1.1).
- `teacher/`:
  - método: verdades incondicionais primeiro; "como eu poderia ter descoberto isso?";
  - planejamento: árvore mínima; o mapa se move com o aluno; apresentar encerra o turno;
  - ensino: um passo, um fato; socrático vs expositivo; nunca capítulos "Nó 3:"; verificar cada passo;
  - previsões;
  - demos (`spawn_demo`: "construa o instrumento, não descreva");
  - contextos: dense_source (Dito/Pressuposto/Pulado/Simplificações, `^pN`), track_step (2:1), drawing_review.
- `practice/`: fica como está nesta fase (a Fase 9 reescreve).
- `handoff.md`: texto do turno de handoff.

**Seleção por fase:**
- `probing` → shared + prober;
- `planning`/`teaching` → shared + teacher;
- PRACTICE → shared (subconjunto) + practice.

**API do loader** (mantém a assinatura):
- `build_system_prompt(mode, context_kind, language, phase, extra_context="", overrides=None)`;
- `build_handoff_prompt(language)`;
- `list_prompt_segments()` → `[{path, source}]`.

**Overrides:**
- ficam em `<vault>/.harness/prompts/<path>`;
- só valem se `config.prompt_overrides[path] is True` **e** o arquivo existir (`HarnessConfig.prompt_overrides: dict[str,bool] = {}`).

**Rotas:**
- `GET /api/settings/prompts` → `[{path, source, override, enabled}]`;
- `PUT /api/settings/prompts/{path:path}` com body `{text, enabled}`;
- `DELETE /api/settings/prompts/{path:path}`;
- o path é validado contra os segmentos existentes; nada fora de `.harness/prompts/`.

Os prompts são escritos em inglês (instruções ao modelo) e mandam responder no idioma da sessão (`language`). Os nomes de ferramentas citados **devem** ser exatamente os da §2.

## 5. API para o frontend

`GET /api/chats/{id}`:
- inclui `phase`, `assessment`, `pending_quiz` (payload estendido, **sem** `correct_indices`, `committed_answer` e `explanation` enquanto pendente, para não vazar a resposta), `answers` (resultados estendidos) e `plan.nodes[]` com `depends_on` e `status` derivado.

`POST /api/chats/{id}/answer` usa o body `QuizSubmission` estendido.

Eventos SSE: os mesmos (notify → fetch).

## 6. Frontend

**QuestionDock:**
- `kind=quiz`: opções embaralhadas de forma determinística por `quiz_id`; seleção única ou múltipla; "Não sei" (desliga a confiança); slider com paradas `[0,30,50,70,90,100]`, padrão 50; textarea "Seu raciocínio".
- `kind=explain`: textarea "Sua resposta" mais "Seu raciocínio", sem confiança, com "Não sei".
- `kind=ask`: opções com `description`, mais "Outro…" com input inline, sem nota e sem confiança.
- **CHECK** aparece recolhido atrás de "Verifique seu entendimento". Enquanto recolhido, um campo **"Pensando enquanto lê"** (`reading_thinking`) fica visível; ao expandir, o texto vai junto na resposta. **PROBE/PREDICTION/ask** aparecem abertos.
- Teclado: ↑/↓ percorre, Espaço escolhe, Enter envia, Tab alterna entre o raciocínio e as opções.

**Transcrição:**
- cartões de pergunta respondida: pergunta, escolha, correto/incorreto, confiança e raciocínio; explain mostra a nota do `grade_recall` quando existir;
- `ProbeDoneCard`: as trilhas e avaliações do `assessment`, recolhível;
- divisórias de fase "Diagnóstico → Planejamento → Ensino" e chip de fase no cabeçalho.

**PlanWindow:**
- desenha o DAG pelas arestas `depends_on`, em camadas, com SVG próprio (sem nova dependência pesada);
- status `current` (destaque), `visited`, `mastered` e `needs_review`.

Tudo com tokens do design system e i18n PT-BR/EN.

## 7. Testes obrigatórios

- **Parser mermaid:** casos válidos e cada erro com linha.
- **Ferramentas:** cada recusa por fase ou estado; `probe_done` → fase `planning` mais o handoff agendado; o primeiro `quiz` com `node_id` → `teaching`; replanejar preserva mastered; `grade_recall` mais mastery via explain CHECK.
- **Resposta pendente não vaza:** a serialização do pendente não contém `correct_indices`, `committed_answer` nem `explanation`.
- **Loader:** seleção por fase, regex de fragmentos, overrides e rotas.
- **Frontend:** `tsc`, `npm test` e `build` passam.
