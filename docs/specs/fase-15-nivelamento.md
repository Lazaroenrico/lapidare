# Fase 15: nivelamento de trilha por busca binária

**Origem:** item 6.3 do plano original e etapa 4 do spec 3.1 do `CONTEXT_AND_BEHAVIOR.md`.

**Caso de uso:** o aluno começa uma trilha (por exemplo, uma matéria da faculdade) da qual já sabe parte. Em vez de passar por todos os passos, ele faz um diagnóstico curto que encontra onde começar.

Os invariantes do `AGENTS.md` valem: não existe um terceiro modo. O nivelamento é uma sessão **TEACH** com `context_kind="leveling"`.

## 1. Comportamento

1. **Início:** o botão **"Nivelar esta trilha"** aparece em Configurações → Trilhas e no menu ▾ do chip, para trilhas com 4 ou mais passos pendentes. Ele faz `POST /api/tracks/{id}/leveling`, que cria a sessão `TEACH` com:
   - `context_kind="leveling"`;
   - `track_id`;
   - o título "Nivelamento: <trilha>";

   e abre a sessão.
2. **Busca binária:**
   - O agente recebe a fila **pendente e ordenada** da trilha: id, título e pré-requisitos.
   - Ele pega o item do meio e faz 1 ou 2 perguntas graduadas sobre ele, com `probe` ou `recall`.
     - **Acerto confiante:** a fronteira está acima. Ele sobe para a metade de cima.
     - **Erro, hesitação ou "não sei":** a fronteira está abaixo. Ele desce.
   - Repete até isolar o primeiro item **não dominado**. São cerca de log₂(n) passos, com no máximo 12 perguntas.
   - Ele também respeita os pré-requisitos: um item cujo pré-requisito ainda não foi dominado nunca é dado como sabido.
3. **Fechamento:**
   - Termina com exatamente uma chamada `leveling_done(known_item_ids: [str], start_item_id: str, summary: str)`.
   - O backend então:
     - marca os `known_item_ids` como `completed` com `status_detail="nivelado"`;
     - move `active_item_id` para `start_item_id`;
     - grava um snapshot dos flags anteriores na sessão, para permitir desfazer;
     - põe a sessão em `phase="completed"`.
4. **Recusas, com texto corretivo:**
   - `plan_init`, `quiz` e `explain` são recusados em `leveling` (aqui não se ensina);
   - um id desconhecido é recusado;
   - um `start_item_id` que está em `known_item_ids` é recusado;
   - o `leveling_done` é recusado se houver uma pergunta pendente ou se já tiver sido chamado.
5. **Desfazer:** `POST /api/tracks/{id}/leveling/{session_id}/undo` restaura os flags e o `active_item_id` do snapshot. Só funciona enquanto nenhum dos itens tiver sido alterado depois.

## 2. Prompts

Novo fragmento **`prober/30-leveling.md`**, carregado apenas para o `context_kind` `leveling` (o loader já seleciona fragmentos por contexto). Ele cobre:
- a busca binária na fila;
- uma pergunta aplicada por item testado, que não revele o título do passo como resposta;
- o critério de "dominado" (acerto com confiança ≥ 70 e raciocínio coerente);
- os pré-requisitos;
- o limite de perguntas;
- o fechamento com `leveling_done`, que encerra a sessão.

O texto é original e em inglês, com respostas no idioma da sessão.

## 3. Frontend

- O botão "Nivelar esta trilha" nos dois lugares.
- `LevelingDoneCard` na transcrição, com:
  - "N passos marcados como já sabidos";
  - a lista recolhível;
  - "começar por: <item>";
  - o resumo;
  - o botão **Desfazer** (com confirmação).
- O chip da trilha se atualiza via `config:updated`.
- A sessão mostra o chip de fase "Nivelamento".
- Strings em PT-BR e EN.

## 4. Testes

- **Backend:**
  - a criação da sessão;
  - o prompt contém a fila pendente ordenada;
  - cada recusa;
  - o `leveling_done` aplica as marcas, o snapshot e a fase;
  - o desfazer, e o desfazer bloqueado quando um item mudou;
  - um fluxo de ponta a ponta com FakeEngine (probe → probe → `leveling_done`).
- **Frontend:** a lógica pura (visibilidade do botão, decodificação do card) com testes.
