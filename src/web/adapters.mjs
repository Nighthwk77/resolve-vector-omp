/**
 * Site adapters for web-based reviewers. ISOLATED per provider: a selector
 * change for one site touches only its entry here.
 *
 * Selector strategy: semantic hooks first (roles, contenteditable, stable
 * ids, data-message-author-role), generic fallbacks last. Generated CSS
 * classes are used only as [class*="..."] substring fallbacks, never alone.
 */
export const ADAPTERS = {
  deepseek: {
    url: "https://chat.deepseek.com/",
    family: "deepseek",
    inputSelectors: ["textarea#chat-input", "textarea"],
    responseSelectors: [".ds-markdown", '[class*="markdown"]'],
    popupCloseSelectors: [".ds-modal-close", '[class*="ds-modal"] [class*="close"]', '[class*="dialog"] button[aria-label*="close" i]'],
    newChatPerConsult: false,
  },
  chatgpt: {
    url: "https://chatgpt.com/",
    family: "openai",
    inputSelectors: ["#prompt-textarea", 'div.ProseMirror[contenteditable="true"]', '[contenteditable="true"]'],
    responseSelectors: ['[data-message-author-role="assistant"]', '[data-testid*="conversation-turn"]'],
    popupCloseSelectors: [],
    newChatPerConsult: false,
  },
  gemini: {
    url: "https://gemini.google.com/app",
    family: "google",
    inputSelectors: ['div.ql-editor[contenteditable="true"]', '[contenteditable="true"]', '[role="textbox"]'],
    responseSelectors: ["message-content", '[class*="response-content"]'],
    popupCloseSelectors: [],
    newChatPerConsult: false,
  },
  perplexity: {
    url: "https://www.perplexity.ai/",
    family: "perplexity",
    inputSelectors: ['[role="textbox"]', '[contenteditable="true"]', "textarea[placeholder]", "textarea"],
    responseSelectors: [".prose", '[class*="prose"]'],
    popupCloseSelectors: [],
    newChatPerConsult: false,
  },
  claude: {
    url: "https://claude.ai/new",
    family: "anthropic",
    inputSelectors: ['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"]'],
    responseSelectors: [".font-claude-response", '[data-testid*="assistant"]', "[data-is-streaming]"],
    popupCloseSelectors: [],
    newChatPerConsult: true,
  },
  kimi: {
    url: "https://www.kimi.com/",
    family: "moonshot",
    inputSelectors: ['div[contenteditable="true"]', "textarea", '[role="textbox"]'],
    responseSelectors: ['[class*="markdown"]', '[class*="message-content"]'],
    popupCloseSelectors: [],
    newChatPerConsult: false,
  },
  glm: {
    url: "https://chat.z.ai/",
    family: "glm",
    inputSelectors: ["textarea#chat-input", "#chat-input", "textarea", '[contenteditable="true"]', '[role="textbox"]'],
    responseSelectors: ['[data-message-author-role="assistant"]', ".markdown-prose", '[class*="markdown"]', ".prose"],
    popupCloseSelectors: [],
    stripResponsePrefixes: ["Thought Process"],
    newChatPerConsult: false,
  },
};

export function getAdapter(app) {
  const adapter = ADAPTERS[app];
  if (!adapter) throw new Error(`unknown web provider "${app}" — known: ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}
