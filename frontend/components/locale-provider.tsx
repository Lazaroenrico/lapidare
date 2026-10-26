"use client";
import {createContext, useContext, useEffect, useState} from 'react';
import {getSetupStatus} from '@/lib/api';
import {useEventSubscription} from './server-events';

const messages = {
  'pt-BR': {
    teachPrompt: 'O que você quer aprender ou explorar hoje?', practicePrompt: 'O que você quer praticar hoje?',
    dontKnow: 'Não sei — me ensina', confidence: 'CONFIANÇA · Grau de certeza', thinking: 'SEU RACIOCÍNIO · Por que escolheu essa opção?',
    thinkingPrompt: 'Explique sua intuição ou raciocínio em uma linha...', submit: 'Enviar resposta',
    settings: 'Configurações do Harness', setup: 'Configuração Inicial do Harness', back: 'Voltar', next: 'Avançar',
    finish: 'Concluir e abrir plataforma', save: 'Salvar', saving: 'Salvando...', close: 'Fechar',
    sessionFailed: 'A execução da aula falhou.', sessionInterrupted: 'A execução da aula foi interrompida.',
    sessionRecovery: 'A pergunta pendente ficou incompleta. Reinicie o diagnóstico para continuar.',
    resume: 'Retomar', restartDiagnostic: 'Reiniciar diagnóstico', resuming: 'Retomando...',
    teaching: 'Ensinando…', queued: 'Na fila…', sendFailed: 'Não foi possível enviar a mensagem.',
    demoFailed: 'Não foi possível gerar o simulador.', dismiss: 'Dispensar',
    statusFailed: 'Falhou', statusInterrupted: 'Interrompida', statusWaiting: 'Aguardando sua resposta',
    statusTeaching: 'Ensinando...', statusCompleted: 'Concluída', statusIdle: 'Parada',
    retry: 'Tentar de novo', retrying: 'Reenfileirando...', agentsIdle: 'Ocioso (nenhum pipeline ativo)',
    // Import multi-fonte
    impTitle: 'Importar para o Vault', impSubtitle: 'Tudo entra em Fontes/ (somente-leitura), ancorado em ^p1..^pN.',
    impSources: 'Origem do conteúdo', impTabMcp: 'MCP', impTabGithub: 'GitHub', impTabLocal: 'Arquivo local',
    impLoading: 'Carregando…', impStartSession: 'Abrir sessão TEACH ao concluir', impImport: 'Importar',
    impImporting: 'Importando…', impCancel: 'Cancelar', impNew: 'NOVO', impFilter: 'Filtrar…',
    impFilterLabel: 'Filtrar itens', impSelectAll: 'Selecionar visíveis', impClear: 'Limpar seleção',
    impSelected: (n: number) => `${n} selecionado(s)`, impImported: (n: number) => `${n} fonte(s) gravada(s) em Fontes/.`,
    impNoItems: 'Este servidor não publicou itens.', impNoMatch: 'Nada corresponde ao filtro.',
    impPickServer: 'Selecione ou conecte um servidor MCP.', impCancelled: 'Operação cancelada.',
    mcpServers: 'Servidores MCP', mcpConnect: '+ Conectar MCP', mcpEmpty: 'Nenhum servidor MCP configurado.',
    mcpName: 'Nome', mcpTransport: 'Transporte', mcpUrl: 'URL', mcpCommand: 'Comando',
    mcpArgs: 'Argumentos (um por linha)', mcpToken: 'Token de acesso (opcional)',
    mcpTokenKeep: 'Em branco mantém o token salvo', mcpTokenHint: 'Guardado fora do Vault; nunca é exibido de volta.',
    mcpHasAuth: 'AUTH', mcpAdvanced: 'Avançado', mcpCatalogTool: 'Tool de catálogo', mcpContentTool: 'Tool de conteúdo',
    mcpContentIdArg: 'Argumento de id do conteúdo', mcpEnabled: 'Habilitado', mcpDisabled: 'desabilitado',
    mcpSave: 'Salvar servidor', mcpTest: 'Testar', mcpTesting: 'Testando…', mcpUntested: 'não testado',
    mcpTestOk: (tools: number, res: number) => `OK · ${tools} tools · ${res} resources`, mcpTestFail: 'Falha no teste',
    mcpEdit: 'Editar', mcpRemove: 'Remover', mcpRequired: 'Informe o nome e a URL (ou o comando, para stdio).',
    mcpConfirmRemove: (n: string) => `Remover o servidor "${n}"? As fontes já importadas continuam no Vault.`,
    mcpTools: 'Tools expostas',
    ghUrl: 'URL do repositório GitHub', ghUrlHint: 'https://github.com/<owner>/<repo>[/tree/<ref>/<pasta>]',
    ghInvalid: 'Use um link https://github.com/<owner>/<repo>.', ghPreview: 'Pré-visualizar',
    ghCloning: 'Clonando e indexando o repositório… pode levar até 2 min.', ghImportingLong: 'Importando arquivos do clone…',
    ghTruncated: 'Lista truncada no limite de 2000 arquivos. Use uma subpasta (/tree/<ref>/<pasta>) para ver o resto.',
    ghFiles: (n: number) => `${n} arquivo(s)`, ghRoot: '(raiz)', ghToggleFolder: 'Expandir ou recolher pasta',
    ghSelectFolder: 'Selecionar pasta', ghUseAsTrack: 'Usar este repositório como Trilha',
    ghUseAsTrackHint: 'Ajusta a Trilha para modo repositório e a gera em segundo plano.',
    ghImportSelected: 'Importar selecionados', ghTrackExists: 'Já existe uma Trilha ativa. Substituí-la por este repositório?',
    ghReplaceTrack: 'Substituir Trilha', ghTrackQueued: 'A Trilha está sendo gerada em segundo plano.',
    ghNoFiles: 'Nenhum arquivo .md/.txt/.ipynb encontrado.',
    locModeFile: 'Arquivo', locModePaste: 'Colar texto', locDrop: 'Arraste um arquivo aqui ou clique para escolher',
    locAccept: '.md · .markdown · .txt · .pdf', locBadExt: 'Formato não suportado. Use .md, .markdown, .txt ou .pdf.',
    locTitleOptional: 'Título (opcional)', locTitle: 'Título', locTitlePh: 'Ex.: Aula 03 — Multi-Head Attention e RoPE',
    locContent: 'Conteúdo / transcrição', locContentPh: 'Cole a transcrição, notas brutas ou documento da mentoria…',
    locChangeFile: 'Trocar arquivo', locReadonly: 'Fontes/ é somente-leitura: reimportar cria uma nova versão.',
    trackGithub: 'Repositório GitHub', trackGithubHint: 'Cole um link do GitHub para clonar o currículo e gerar a Trilha a partir dele.',
    trackValidate: 'Validar', trackLink: 'Usar como Trilha',
    trackLinked: 'Repositório vinculado. A Trilha está sendo gerada em segundo plano.',
    mcpSettingsTitle: 'Servidores MCP de Conteúdo',
    mcpSettingsHint: 'O botão "↑ Import" lista e ingere conteúdo destes servidores (HTTP, SSE ou stdio).',
    setupRecommended: 'Recomendado', setupDetected: 'Detectado', setupNotFound: 'Não encontrado',
    setupGeminiDeprecation: 'Contas individuais do Gemini Code Assist não são mais aceitas pelo gemini CLI: use o Antigravity (agy).',
  },
  en: {
    teachPrompt: 'What would you like to learn or explore today?', practicePrompt: 'What would you like to practice today?',
    dontKnow: "I don't know — teach me", confidence: 'CONFIDENCE · How certain are you?', thinking: 'YOUR THINKING · Why did you choose this option?',
    thinkingPrompt: 'Explain your intuition or reasoning in one line...', submit: 'Submit answer',
    settings: 'Harness settings', setup: 'Initial Harness setup', back: 'Back', next: 'Next',
    finish: 'Finish and open platform', save: 'Save', saving: 'Saving...', close: 'Close',
    sessionFailed: 'The lesson run failed.', sessionInterrupted: 'The lesson run was interrupted.',
    sessionRecovery: 'The pending question is incomplete. Restart the diagnostic to continue.',
    resume: 'Resume', restartDiagnostic: 'Restart diagnostic', resuming: 'Resuming...',
    teaching: 'Teaching…', queued: 'Queued…', sendFailed: 'Could not send the message.',
    demoFailed: 'Could not generate the simulator.', dismiss: 'Dismiss',
    statusFailed: 'Failed', statusInterrupted: 'Interrupted', statusWaiting: 'Waiting for your answer',
    statusTeaching: 'Teaching...', statusCompleted: 'Completed', statusIdle: 'Idle',
    retry: 'Retry', retrying: 'Re-queuing...', agentsIdle: 'Idle (no active pipelines)',
    // Multi-source import
    impTitle: 'Import into the Vault', impSubtitle: 'Everything lands in Sources/ (read-only), anchored as ^p1..^pN.',
    impSources: 'Content source', impTabMcp: 'MCP', impTabGithub: 'GitHub', impTabLocal: 'Local file',
    impLoading: 'Loading…', impStartSession: 'Open a TEACH session when done', impImport: 'Import',
    impImporting: 'Importing…', impCancel: 'Cancel', impNew: 'NEW', impFilter: 'Filter…',
    impFilterLabel: 'Filter items', impSelectAll: 'Select visible', impClear: 'Clear selection',
    impSelected: (n: number) => `${n} selected`, impImported: (n: number) => `${n} source(s) written to Sources/.`,
    impNoItems: 'This server published no items.', impNoMatch: 'Nothing matches the filter.',
    impPickServer: 'Select or connect an MCP server.', impCancelled: 'Operation cancelled.',
    mcpServers: 'MCP servers', mcpConnect: '+ Connect MCP', mcpEmpty: 'No MCP server configured.',
    mcpName: 'Name', mcpTransport: 'Transport', mcpUrl: 'URL', mcpCommand: 'Command',
    mcpArgs: 'Arguments (one per line)', mcpToken: 'Access token (optional)',
    mcpTokenKeep: 'Leave blank to keep the saved token', mcpTokenHint: 'Stored outside the Vault; never shown back.',
    mcpHasAuth: 'AUTH', mcpAdvanced: 'Advanced', mcpCatalogTool: 'Catalog tool', mcpContentTool: 'Content tool',
    mcpContentIdArg: 'Content id argument', mcpEnabled: 'Enabled', mcpDisabled: 'disabled',
    mcpSave: 'Save server', mcpTest: 'Test', mcpTesting: 'Testing…', mcpUntested: 'untested',
    mcpTestOk: (tools: number, res: number) => `OK · ${tools} tools · ${res} resources`, mcpTestFail: 'Test failed',
    mcpEdit: 'Edit', mcpRemove: 'Remove', mcpRequired: 'Provide a name and a URL (or a command, for stdio).',
    mcpConfirmRemove: (n: string) => `Remove server "${n}"? Already imported sources stay in the Vault.`,
    mcpTools: 'Exposed tools',
    ghUrl: 'GitHub repository URL', ghUrlHint: 'https://github.com/<owner>/<repo>[/tree/<ref>/<folder>]',
    ghInvalid: 'Use a https://github.com/<owner>/<repo> link.', ghPreview: 'Preview',
    ghCloning: 'Cloning and indexing the repository… this can take up to 2 min.', ghImportingLong: 'Importing files from the clone…',
    ghTruncated: 'List truncated at 2000 files. Use a subfolder (/tree/<ref>/<folder>) to see the rest.',
    ghFiles: (n: number) => `${n} file(s)`, ghRoot: '(root)', ghToggleFolder: 'Expand or collapse folder',
    ghSelectFolder: 'Select folder', ghUseAsTrack: 'Use this repository as the Track',
    ghUseAsTrackHint: 'Switches the Track to repository mode and generates it in the background.',
    ghImportSelected: 'Import selected', ghTrackExists: 'A Track is already active. Replace it with this repository?',
    ghReplaceTrack: 'Replace Track', ghTrackQueued: 'The Track is being generated in the background.',
    ghNoFiles: 'No .md/.txt/.ipynb files found.',
    locModeFile: 'File', locModePaste: 'Paste text', locDrop: 'Drop a file here or click to choose',
    locAccept: '.md · .markdown · .txt · .pdf', locBadExt: 'Unsupported format. Use .md, .markdown, .txt or .pdf.',
    locTitleOptional: 'Title (optional)', locTitle: 'Title', locTitlePh: 'E.g. Lesson 03 — Multi-Head Attention and RoPE',
    locContent: 'Content / transcript', locContentPh: 'Paste the transcript, raw notes or mentoring document…',
    locChangeFile: 'Change file', locReadonly: 'Sources/ is read-only: re-importing creates a new version.',
    trackGithub: 'GitHub repository', trackGithubHint: 'Paste a GitHub link to clone the curriculum and build the Track from it.',
    trackValidate: 'Validate', trackLink: 'Use as Track',
    trackLinked: 'Repository linked. The Track is being generated in the background.',
    mcpSettingsTitle: 'Content MCP servers',
    mcpSettingsHint: 'The "↑ Import" button lists and ingests content from these servers (HTTP, SSE or stdio).',
    setupRecommended: 'Recommended', setupDetected: 'Detected', setupNotFound: 'Not found',
    setupGeminiDeprecation: 'Individual Gemini Code Assist accounts are no longer accepted by the gemini CLI: use Antigravity (agy).',
  },
};
type Locale = keyof typeof messages;
const LocaleContext = createContext({locale: 'pt-BR' as Locale, t: messages['pt-BR']});
export function LocaleProvider({children}: {children: React.ReactNode}) {
  const [locale, setLocale] = useState<Locale>('pt-BR');
  const [error, setError] = useState('');
  const refresh = () => getSetupStatus().then(s => setLocale(s.config?.language === 'en' ? 'en' : 'pt-BR')).catch(e => setError(e.message));
  useEffect(() => {void refresh(); const onError = (e: Event) => setError((e as CustomEvent<string>).detail);
    window.addEventListener('harness:error', onError); return () => window.removeEventListener('harness:error', onError);}, []);
  useEventSubscription('config:updated', () => {void refresh();});
  useEffect(() => {document.documentElement.lang = locale;}, [locale]);
  return <LocaleContext.Provider value={{locale, t: messages[locale]}}>
    {error && <div role="alert" className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] bg-[#1c1c1c] border border-[#434343] p-4 font-ui text-xs max-w-xl">{error}<button className="ml-4 underline" onClick={() => setError('')}>{messages[locale].close}</button></div>}
    {children}
  </LocaleContext.Provider>;
}
export const useLocale = () => useContext(LocaleContext);
