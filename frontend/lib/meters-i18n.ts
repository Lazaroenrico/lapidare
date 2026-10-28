/** PT-BR / EN strings of the Fase 21 meters, graph toggles and unlink. Pick with `metersText(locale)`. */
import type { TurnRow } from "./usage";

const ptBR = {
  ringLabel: "Cobertura da extração para o grafo",
  contextTitle: "Contexto da sessão",
  contextOf: (used: string, limit: string, kind: "compaction" | "window") =>
    `${used} / ${limit} ${kind === "window" ? "até o limite do modelo" : "até compactar"}`,
  lastTurn: "Último turno",
  lastTurnNone: "Sem turno registrado.",
  turnRow: { input: "Entrada", output: "Saída", thinking: "Raciocínio", cached: "Cache" } as Record<TurnRow["key"], string>,
  sessionTotal: "Total da sessão",
  extractionSwitch: "Extrair automaticamente para o grafo",
  extractionSwitchHint: "Desligado, a sessão não alimenta o grafo e a extração manual fica bloqueada. Importar notas continua funcionando.",
  extractionSaved: "Salvo.",
  extractionFailed: "Não foi possível salvar.",
  renderingSwitch: "Mostrar o grafo na Home",
  renderingSwitchHint: "Desligado, a Home mostra só as contagens, sem desenhar o grafo. Salvo neste navegador.",
  minimalHome: "Home sem grafo",
  countNodes: (n: number) => `${n} ${n === 1 ? "nó" : "nós"}`,
  countChains: (n: number) => `${n} ${n === 1 ? "cadeia" : "cadeias"}`,
  countSessions: (n: number) => `${n} ${n === 1 ? "sessão" : "sessões"}`,
  countSources: (n: number) => `${n} ${n === 1 ? "fonte" : "fontes"}`,
  unlinkMenu: "Remover do grafo",
  unlinkTitle: "Remover do grafo?",
  unlinkBody: "Os nós que só vieram desta sessão saem do grafo. A sessão continua, e pode ser extraída de novo.",
  unlinkConfirm: "Remover",
  unlinkBusy: "Removendo…",
  unlinkFailed: "Não foi possível remover do grafo.",
};

const en: typeof ptBR = {
  ringLabel: "Graph extraction coverage",
  contextTitle: "Session context",
  contextOf: (used, limit, kind) => `${used} / ${limit} ${kind === "window" ? "to the model limit" : "until compaction"}`,
  lastTurn: "Last turn",
  lastTurnNone: "No turn recorded.",
  turnRow: { input: "Input", output: "Output", thinking: "Thinking", cached: "Cache" },
  sessionTotal: "Session total",
  extractionSwitch: "Extract to the graph automatically",
  extractionSwitchHint: "When off, the session does not feed the graph and manual extraction is blocked. Importing notes still works.",
  extractionSaved: "Saved.",
  extractionFailed: "Could not save.",
  renderingSwitch: "Show the graph on the Home",
  renderingSwitchHint: "When off, the Home shows counts only and does not draw the graph. Saved in this browser.",
  minimalHome: "Home without graph",
  countNodes: (n) => `${n} ${n === 1 ? "node" : "nodes"}`,
  countChains: (n) => `${n} ${n === 1 ? "chain" : "chains"}`,
  countSessions: (n) => `${n} ${n === 1 ? "session" : "sessions"}`,
  countSources: (n) => `${n} ${n === 1 ? "source" : "sources"}`,
  unlinkMenu: "Remove from graph",
  unlinkTitle: "Remove from the graph?",
  unlinkBody: "Nodes that came only from this session leave the graph. The session stays, and can be extracted again.",
  unlinkConfirm: "Remove",
  unlinkBusy: "Removing…",
  unlinkFailed: "Could not remove from the graph.",
};

export type MetersText = typeof ptBR;
export const metersText = (locale: string): MetersText => (locale.toLowerCase().startsWith("en") ? en : ptBR);
