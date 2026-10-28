# Fase 20: Subagentes Google-only (pesquisa e PDF)

Os invariantes do `AGENTS.md` valem:
- `core/` continua puro; o teste AST está em `tests/unit/test_core_contracts.py`;
- só caminhos Google;
- subprocessos via `child_env()`.

A interface MCP **não muda**. Continuam `research(question, context)` e `read_pdf(path, question)`. `golden/tool_catalog.json` fica intacto, e os pontos de entrada `run_research_job` e `run_pdf_job` que `services/jobs.py` chama mantêm nome e assinatura.

## 1. Pesquisa em várias etapas

**Hoje.** `services/research.py` faz uma única chamada `engine.research(prompt)`. Ela devolve `{question, engine, brief, sources:[{title,url}]}`, e o resumo tem 4 seções (`_SECTIONS`: Resumo / Achados citados / Fontes / Lacunas).

### 1.1 Contratos

Em `core/contracts/jobs.py`:
- `ResearchFacet{name: str, queries: list[str]}`, com 1 a 3 queries.
- `ResearchPlan{facets: list[ResearchFacet]}`, com 2 a 5 facetas.
- `ResearchGaps{missing: list[str] = [], follow_up: list[ResearchFacet] = []}`.
- `ResearchResult` ganha `facets: list[str] = []` e `engine: str | None = None`. Continua compatível com o formato antigo.

### 1.2 Funções puras

Em `core/research.py`:
- **`merge_sources(groups)`:** une as listas de fontes deduplicando por URL normalizada (esquema e host em minúsculas, sem fragmento e sem barra final). Mantém a primeira ocorrência e completa o título vazio com a URL.
- **`validate_citations(brief, n_sources)`:** encontra as referências `[n]` no resumo e devolve as que estão fora de `1..n_sources`.
- **`clamp_plan(plan, max_facets=5)`:** remove facetas sem query e corta o excedente.

### 1.3 Laço

Em `services/research_agent.py`, chamado por `run_research_job`. O módulo `services/research.py` continua com a seleção de engine, com `build_research_prompt` (que passa a receber a faceta) e com `_clean`.

**Etapas**
1. **Planejar.** `run_structured(prompt, schema=ResearchPlan, slot=background)` gera as facetas para a pergunta e o contexto. Se falhar, usa uma faceta única igual à pergunta original.
2. **Buscar.** Para cada faceta, `engine.research(prompt_da_faceta, slot=…)` com no máximo 2 em paralelo (`asyncio.Semaphore(2)`). O engine é o mesmo escolhido por `research_engine(state)`. Se uma faceta falhar, as outras seguem; se todas falharem, levanta o erro como hoje.
3. **Lacunas.** No máximo uma rodada. `run_structured(schema=ResearchGaps)` recebe os achados resumidos. As facetas de `follow_up` (até 2) passam pela etapa 2.
4. **Sintetizar.** `run_structured(schema=ResearchResult)` recebe os achados por faceta e **a lista numerada de fontes coletadas**. O resumo cita `[n]` e mantém as 4 seções.
   - `sources` = `merge_sources` das coletas. Fontes inventadas pelo modelo são descartadas.
   - Se `validate_citations` acusar problema, faz uma rodada de correção passando os índices inválidos, no padrão de `generate_visual` em `services/visuals.py`.
   - Se a falha persistir, remove as referências inválidas do texto.

**Limites:** `MAX_FACETS=5`, `MAX_ENGINE_CALLS=8` (contando as buscas), `MAX_ROUNDS=2`.

**Progresso.** Via `progress()` do JobManager, em PT, como o restante: `"planejando facetas"`, `"faceta 2/4: <nome>"`, `"conferindo lacunas"`, `"sintetizando"`.

**Resultado:** `{question, engine, brief, sources, facets}`. O steer e a nota da aula continuam iguais, porque `_done_content` e `lesson_layout` já usam `brief` e `sources`.

### 1.4 `genai_sdk_engine.py`

- `research` passa a usar `tools=[Tool(google_search=GoogleSearch()), Tool(url_context=UrlContext())]`. Se a versão do SDK instalada não tiver `UrlContext`, cai só para `google_search`. Confira a versão no `uv.lock` antes.
- Juntar às fontes as URLs de `url_context_metadata`, quando houver.

## 2. PDF com visão

**Hoje.** `services/pdf_reader.py` usa pypdf e lê no máximo 8 páginas de texto, sem visão. PDF sem texto dá erro.

### 2.1 Dependência

Adicionar `pypdfium2` em `backend/pyproject.toml` e atualizar o `uv.lock` com `uv lock`. O desktop instala a partir do `uv export` do lock com hashes, então não há outro arquivo para mexer. Registre no relatório o tamanho que o wheel acrescenta.

Não adicionar Pillow nem numpy.

### 2.2 Renderização

Em `services/pdf_render.py`:
- **`render_page_png(path, page_number, dpi=144, max_px=1600)`:** renderiza a página com pypdfium2 (`render(scale=…)`), lê o buffer RGB/BGRA do bitmap e codifica em PNG.
- **`encode_png(width, height, rgb_bytes)`:** encoder mínimo com `zlib` e `struct` (assinatura, IHDR, IDAT, IEND e CRC). Converta BGR(A) para RGB.
- **`page_visual_hints(path)`:** devolve, por página, se há objetos de imagem (pypdfium2 `get_objects` com filtro de imagem).
- Rode as chamadas pesadas com `asyncio.to_thread`.

### 2.3 Contratos e funções puras

**Contratos**, em `core/contracts/jobs.py`:
- `PdfTriage{draft: str, visual_pages: list[int] = [], confident: bool = False}`.
- `PdfPageReading{page: int, findings: str, figures: list[str] = []}`.
- `PdfAnswer` ganha `figures: list[PdfFigure] = []` (`PdfFigure{page, description}`) e `pages_viewed: list[int] = []`.

**Funções puras**, em `core/pdf_reading.py`:
- **`select_visual_pages(requested, page_count, hints, text_lens, limit=4)`:** faz a interseção com as páginas existentes e mantém a ordem pedida. Se nada foi pedido e o texto é escasso, usa as páginas com imagem ou com pouco texto.
- **`validate_page_citations(answer, allowed)`:** devolve as páginas citadas com `(p. N)` que estão fora de `allowed`.

### 2.4 Laço

Em `services/pdf_agent.py`, chamado por `run_pdf_job`. O módulo `pdf_reader.py` mantém `resolve_pdf`, `extract_pages` e `triage`.

**Etapas**
1. **Extrair.** Texto (pypdf, como hoje) e `page_visual_hints`.
2. **Triagem.** Só quando há texto. `run_structured(schema=PdfTriage)` sobre as até 8 páginas de `triage()` e o número total de páginas. O prompt pede as páginas que precisam ser vistas: figura, tabela, equação ou diagrama citados no texto.
3. **Visão.** Para cada página de `select_visual_pages` (no máximo 4), `render_page_png` seguido de `engine.review_image(png, instructions, schema=PdfPageReading, slot=background, image_name=f"p{n}.png")`. Use `getattr` como em `visuals.check_visual`. Se `review_image` não existir ou levantar `EngineError`, `TimeoutError`, `ValueError` ou `NotImplementedError`, pare a visão e registre em `warnings`.
4. **Sintetizar.** `run_structured(schema=PdfAnswer)` sobre o texto e as leituras. As citações `(p. N)` são validadas contra páginas lidas ∪ páginas vistas, com uma rodada de correção, no padrão do `generate_visual`.

**PDF sem texto (escaneado).** Pula a triagem e vê as primeiras 4 páginas. Só falha se a visão também não for possível, com a mensagem atual de "sem texto extraível…", acrescida de "e a visão não está disponível".

**Limite:** no máximo 7 chamadas de modelo por job.

**Progresso:** `"extraindo texto de X"`, `"triagem"`, `"vendo p. N"`, `"sintetizando"`.

**Resultado:** o mesmo dict de hoje (`path, file, question, answer, page_count, pages_read, pages_cited, terms_matched`), mais `pages_viewed`, `figures` e, se houver, `warnings`. O JobManager já move `warnings` para o registro.

**Steer.** `_done_content` para pdf (`services/jobs.py`) passa a listar também "páginas vistas" e as figuras. Se o texto do steer mudar, regenere os goldens de `tests/golden/turns/steers-*`.

## 3. Cancelar job

### 3.1 Backend

- **`JobManager.cancel(job_id)`:** se a task do job está viva, marca a intenção de cancelamento e chama `task.cancel()`. O caminho `CancelledError` em `run()` já grava `interrupted`. Diferencie o cancelamento pelo usuário do desligamento do servidor (`close()`):
  - **pelo usuário:** `error = "cancelado pelo usuário"` e um steer de falha entregue uma vez, com o texto atual de falha;
  - **no shutdown:** continua sem steer, como hoje.
  - Um job `queued` que ainda não começou também pode ser cancelado.
  - Um job terminado devolve 409.
- **Rota:** `POST /api/jobs/{job_id}/cancel` em `api/routes/jobs.py`. Devolve 404 se o job não existe e 409 se já terminou. Faz broadcast via `save()`, como os demais.
- **Retry:** um job cancelado pode ser retentado (status `interrupted`), como hoje.

### 3.2 Frontend

- **`api.ts`:** `cancelJob(id)`.
- **Bandeja** (`components/sidebar.tsx`, seção "Ativos"): botão ⏹ com `aria-label` "Cancelar" / "Cancel" em cada job ativo. Erros aparecem como no retry.
- **`PdfCard`** (`components/job-cards.tsx`):
  - mostra "páginas vistas: p. …" quando houver;
  - lista as figuras (`p. N — descrição`);
  - `lib/job-steer.ts` decodifica `pages_viewed` e `figures` de forma tolerante, com teste.
- **`ResearchCard`:** mostra as facetas como chips discretos, se houver.

## 4. Testes (pytest, sem rede)

**Core**
- `merge_sources`: normalização e dedup.
- `validate_citations`.
- `clamp_plan`.
- `select_visual_pages`.
- `validate_page_citations`.
- `encode_png`: assinatura, CRC do IHDR e round-trip descomprimindo o IDAT.

**Pesquisa.** Use o `FakeEngine` de `tests/conftest.py`, com `program(schema, …)` e um `research` roteirizado (há exemplo em `test_background_jobs.py`). Casos:
- caminho feliz com 3 facetas;
- uma faceta falha e as outras seguem;
- todas falham e o job falha com steer de falha;
- limite de chamadas respeitado;
- citação inválida corrigida e, se persistir, removida;
- fonte inventada na síntese é descartada.

**PDF.** `review_image` roteirizado, como em `test_artifact_checks.py`. Casos:
- texto com uma página que precisa ser vista;
- escaneado só com visão;
- engine sem `review_image` degrada para texto, com `warnings`;
- limite de 7 chamadas;
- pypdfium2 real renderizando o PDF em memória dos testes existentes, conferindo que o PNG é válido.

**genai.** O stub do SDK recebe as tools `google_search` + `url_context` (`tests/unit/test_research_engines.py`).

**Cancelamento:**
- cancelar um job rodando grava `interrupted`, `error` e exatamente um steer;
- 409 para um job terminado e 404 para um id inexistente;
- shutdown continua sem steer.

**Frontend (node --test):** decoder de `pages_viewed`, `figures` e `facets`.

## 5. Pronto quando

- `make check` passa e `cd desktop && npm test` passa.
- O catálogo de ferramentas não mudou (o teste do golden continua verde).
- Os goldens de steer, se mudaram, foram regenerados de propósito.
