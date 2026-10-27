# Fases 16–18: notas no grafo, artefatos verificados e Home vazia

Os invariantes do `AGENTS.md` valem. Todo código é original: o upstream (AGPL) serve só como referência de comportamento.

## Fase 16: notas → grafo

**Objetivo.** Além das sessões, arquivos de anotação alimentam o rastro, como o "Import notes…" do upstream.

**Fontes aceitas:**
- arquivos enviados (`.md`, `.txt`, `.pdf`);
- notas que já existem no vault: qualquer `.md` fora de `.harness/` e de `Conceitos/`, incluindo `Fontes/` e `Aulas/`.

**Rotas:**
- `POST /api/graph/import`, multipart com `files[]`. Cada arquivo é gravado como fonte em `Fontes/Notas/…` pelo importador existente (com `^pN`, somente leitura) e depois extraído.
- `POST /api/graph/import-vault`, body `{paths: [str]}`. Extrai notas que já estão no vault, **sem copiá-las nem alterá-las**.

**Identidade da fonte:**
- `source_id = "src_" + sha256(caminho relativo)[:12]`;
- o registro fica em `.harness/graph/sources.jsonl` (append-only): `{id, path, title, imported_at}`.

**Extração:**
- reutiliza o pipeline extrator → auditor → merger com um preâmbulo de "notas do aluno";
- os lotes são fatias por título (`#`) ou por parágrafo, dentro do orçamento `graph.extraction_chunk_tokens`;
- a cobertura é por `(source_id, fatia, fingerprint)`, então reimportar sem mudanças não reextrai nada;
- a proveniência do nó usa `{session_id: source_id, message_id: "pN"}`, e as notas de `Conceitos/` citam `[[<nota>#^pN]]` quando houver âncora (senão `[[<nota>]]`).

**Snapshot:** clusters com `kind: "notes"`, cujo rótulo é o título do arquivo. Os nós dessas fontes entram no layout radial como pétalas.

**Job:**
- `notes_import`, com uma linha por arquivo em BACKGROUND AGENTS;
- status por arquivo: completed / failed / partial;
- até 3 arquivos em paralelo, pelo semáforo existente.

**Exclusão:** `DELETE /api/graph/sources/{id}?mode=preserve-graph|delete-nodes`, com o mesmo `unlink` das sessões. **Nunca** apaga a nota.

**UI:**
- o botão `↑ Import` ganha a opção "Adicionar ao grafo";
- arquivos locais e um seletor de notas do vault (árvore com busca);
- resultado por arquivo;
- o cartão do nó mostra a origem "nota: <título>", com link para abrir a nota.

## Fase 17: artefatos verificados

**Demo:**
1. O job gera o HTML.
2. Roda o HTML no Chromium headless do sistema (`/usr/bin/chromium` ou o que estiver no `PATH`, detectado em tempo de execução; se não houver, o comportamento atual continua e um aviso aparece no job). Usa `--headless=new --enable-logging=stderr --v=0 --virtual-time-budget=4000 --dump-dom`, ou o equivalente, e coleta erros de console e exceções do stderr.
3. Se houver erro, pede ao modelo uma correção com os erros, até 3 rodadas.
4. Só entrega o HTML que rodou limpo. Senão, o job falha com os erros.

Testes com um HTML quebrado de propósito (fake engine e um Chromium simulado ou real, com skip se não houver).

**Visual:**
1. Depois do SVG válido, renderiza para PNG com o Chromium headless (`--screenshot` de um HTML que embute o SVG).
2. Passa o PNG ao modelo pela revisão por visão (a política `vision` do agy já existe; o SDK aceita imagem).
3. A pergunta é "o desenho comunica o brief? há texto sobreposto, cortado ou ilegível?". Até 2 rodadas de `edit`.
4. O resultado ganha `checked: true|false` e notas.

**Atividade do job** ("testando no navegador", "conferindo o visual") e o `ARCHITECTURE.md` atualizado.

## Fase 18: Home vazia e primeiros passos

Com o grafo vazio (0 nós), a Home mostra, no lugar do canvas vazio, um estado inicial discreto no estilo constelação:
- uma frase sobre o rastro ("seu mapa de conhecimento aparece aqui conforme você estuda");
- três ações: **Começar um tema** (foca o composer), **Importar notas para o grafo** (Fase 16) e **Criar uma trilha** (abre o diálogo de nova trilha);
- com sessões na Lixeira, um link "Restaurar sessões (N)".

Com uma trilha ativa e o grafo vazio, o ⇶ Roteiro já aparece como sugestão. Tudo some quando o primeiro nó chega (via SSE), em PT-BR e EN e com tokens.
